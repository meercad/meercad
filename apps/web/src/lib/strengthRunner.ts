/**
 * Runs a strength request off the page: in a worker of its own, which a cancel simply ends. Where
 * there are no workers (the tests) it runs in place.
 */
import { answerStrength, type StrengthAnswer, type StrengthRequest } from "@meercad/model";
import { lightSuggestion } from "./strengthFinish";

export interface StrengthRun {
  answer: Promise<StrengthAnswer | null>;
  /** Ends the calculation; the answer is then null. */
  cancel(): void;
}

export function runStrength(request: StrengthRequest, onProgress: (share: number) => void): StrengthRun {
  if (typeof Worker === "undefined") {
    return {
      answer: Promise.resolve().then(() => answerStrength(request, onProgress, lightSuggestion)),
      cancel: () => undefined,
    };
  }

  const worker = new Worker(new URL("../strength.worker.ts", import.meta.url), { type: "module" });
  let finish: (answer: StrengthAnswer | null) => void = () => undefined;
  const answer = new Promise<StrengthAnswer | null>((resolve) => (finish = resolve));
  const end = (result: StrengthAnswer | null) => (worker.terminate(), finish(result));

  worker.onmessage = (event: MessageEvent<StrengthAnswer | { kind: "progress"; progress: number }>) =>
    event.data.kind === "progress" ? onProgress(event.data.progress) : end(event.data);
  worker.onerror = () => end({ kind: "error", reason: "failed" });
  worker.postMessage(request);

  return { answer, cancel: () => end(null) };
}
