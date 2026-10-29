import Capacitor
import Foundation
import FoundationModels

/// The in-app copilot: Apple's language model with the web app's modelling tools.
///
/// The web app describes its tools (name, description, parameters); they become real tools of a
/// `LanguageModelSession`. When the model calls one, the call goes to the web app as a `toolCall`
/// event, the web app runs it and answers with `toolResult`, and the model sees that result. The
/// session lives on between questions, so the user can refer back ("make it taller").
///
/// Only the on-device model is used for now: Apple's larger Private Cloud Compute model reports
/// itself available but refuses third-party requests without further setup (seen on macOS 27:
/// ModelManagerError 1046). Each step is written to Documents/copilot.log for looking into problems.
@objc(CopilotPlugin)
public class CopilotPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CopilotPlugin"
    public let jsName = "Copilot"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ask", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "toolResult", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise),
    ]

    /// Typed as `Any` so the class stays usable before iOS 26.
    private var session: Any?
    private var model = ""
    private let calls = ToolCalls()

    @objc func availability(_ call: CAPPluginCall) {
        guard #available(iOS 26, *) else {
            return call.resolve(["available": false, "reason": "The copilot needs iOS 26 or later."])
        }
        let local = SystemLanguageModel.default.availability
        var reason = ""
        if case .unavailable(let why) = local {
            switch why {
            case .deviceNotEligible: reason = "This device does not support Apple Intelligence."
            case .appleIntelligenceNotEnabled: reason = "Turn on Apple Intelligence in Settings to use the copilot."
            case .modelNotReady: reason = "Apple's language model is still downloading. Try again in a while."
            @unknown default: reason = "Apple's language model is not available."
            }
        }
        Self.log("availability \(local)")
        call.resolve(["available": local == .available, "onDevice": local == .available, "cloud": false, "reason": reason])
    }

    @objc func reset(_ call: CAPPluginCall) {
        session = nil
        call.resolve()
    }

    @objc func toolResult(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("no id") }
        calls.finish(id, call.getString("result") ?? "")
        call.resolve()
    }

    @objc func ask(_ call: CAPPluginCall) {
        guard #available(iOS 26, *) else { return call.reject("The copilot needs iOS 26 or later.") }
        guard let prompt = call.getString("prompt"), !prompt.isEmpty else { return call.reject("no prompt") }
        let specs = call.getArray("tools", JSObject.self) ?? []
        let instructions = call.getString("instructions") ?? ""
        Self.log("ask \(prompt.count) chars, \(specs.count) tools")
        Task {
            do {
                let s = try self.currentSession(specs: specs, instructions: instructions)
                Self.log("session ready (\(self.model))")
                let response = try await s.respond(to: prompt)
                Self.log("answer \(response.content.count) chars")
                call.resolve(["text": response.content, "model": self.model])
            } catch let error as LanguageModelSession.GenerationError {
                Self.log("generation error \(error)")
                // A full context starts over on the next question.
                if case .exceededContextWindowSize = error { self.session = nil }
                call.reject(Self.message(for: error), "generation")
            } catch {
                Self.log("error \(error)")
                call.reject(error.localizedDescription)
            }
        }
    }

    @available(iOS 26, *)
    private func currentSession(specs: [JSObject], instructions: String) throws -> LanguageModelSession {
        if let s = session as? LanguageModelSession { return s }
        let tools: [any Tool] = try specs.map { try BridgeTool(spec: $0, plugin: self) }
        let s = LanguageModelSession(tools: tools, instructions: instructions)
        model = "on device"
        session = s
        return s
    }

    /// Sends a tool call to the web app and waits for its answer.
    func runTool(_ name: String, _ arguments: String) async -> String {
        let id = UUID().uuidString
        Self.log("tool \(name) \(arguments)")
        let result = await withCheckedContinuation { done in
            calls.start(id, done)
            // The model calls tools from its own threads; the bridge to the web view is used from the main one.
            DispatchQueue.main.async {
                self.notifyListeners("toolCall", data: ["id": id, "name": name, "arguments": arguments])
            }
        }
        Self.log("tool result \(result.prefix(200))")
        return result
    }

    /// Appends a line to Documents/copilot.log (kept small).
    static func log(_ line: String) {
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("copilot.log")
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        if size > 200_000 { try? FileManager.default.removeItem(at: url) }
        let text = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(Data(text.utf8))
            try? h.close()
        } else {
            try? Data(text.utf8).write(to: url)
        }
    }

    @available(iOS 26, *)
    private static func message(for error: LanguageModelSession.GenerationError) -> String {
        switch error {
        case .exceededContextWindowSize: return "The conversation got too long for the model. It starts over with your next message."
        case .guardrailViolation: return "Apple's model declined to answer that."
        case .assetsUnavailable: return "Apple's language model is not available right now."
        case .rateLimited: return "The model is busy or the usage limit is reached. Try again in a moment."
        case .unsupportedLanguageOrLocale: return "Apple's model does not support this language here."
        case .refusal: return "Apple's model declined to answer that."
        default: return error.localizedDescription
        }
    }
}

/// Waiting tool calls by id (touched from the bridge and from the model's tasks).
final class ToolCalls: @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: [String: CheckedContinuation<String, Never>] = [:]

    func start(_ id: String, _ c: CheckedContinuation<String, Never>) {
        lock.lock()
        waiting[id] = c
        lock.unlock()
    }

    func finish(_ id: String, _ result: String) {
        lock.lock()
        let c = waiting.removeValue(forKey: id)
        lock.unlock()
        c?.resume(returning: result)
    }
}

/// One of the web app's tools, described as `{ name, description, params: [{ name, type, description,
/// options?, optional? }] }` with type "number", "integer", "string" or "choice".
@available(iOS 26, *)
/// The plugin is only used to send the call on (on the main bridge), so the tool can cross tasks.
struct BridgeTool: Tool, @unchecked Sendable {
    let name: String
    let description: String
    let parameters: GenerationSchema
    private weak var plugin: CopilotPlugin?

    init(spec: JSObject, plugin: CopilotPlugin) throws {
        let toolName = spec["name"] as? String ?? "tool"
        name = toolName
        description = spec["description"] as? String ?? ""
        let params = spec["params"] as? JSArray ?? []
        let properties: [DynamicGenerationSchema.Property] = params.compactMap { item in
            guard let p = item as? JSObject, let pname = p["name"] as? String else { return nil }
            let schema: DynamicGenerationSchema
            switch p["type"] as? String {
            case "number": schema = DynamicGenerationSchema(type: Double.self)
            case "integer": schema = DynamicGenerationSchema(type: Int.self)
            case "choice": schema = DynamicGenerationSchema(name: "\(toolName)_\(pname)", anyOf: (p["options"] as? JSArray ?? []).compactMap { $0 as? String })
            default: schema = DynamicGenerationSchema(type: String.self)
            }
            return DynamicGenerationSchema.Property(name: pname, description: p["description"] as? String, schema: schema, isOptional: p["optional"] as? Bool ?? false)
        }
        parameters = try GenerationSchema(root: DynamicGenerationSchema(name: toolName, description: spec["description"] as? String, properties: properties), dependencies: [])
        self.plugin = plugin
    }

    func call(arguments: GeneratedContent) async throws -> String {
        guard let plugin else { return "The app is not ready." }
        return await plugin.runTool(name, arguments.jsonString)
    }
}
