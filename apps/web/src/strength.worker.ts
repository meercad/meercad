/** The strength check and the topology suggestion run here, so the app stays responsive meanwhile. */
import { answerStrength, type StrengthRequest } from "@meercad/model";
import { lightTopology } from "./lib/strengthFinish";
import { helpersReady, startHelpers } from "./lib/strengthThreads";

const scope = self as unknown as {
  onmessage: (event: MessageEvent<StrengthRequest>) => void;
  postMessage(message: unknown): void;
};

// Helper threads share the heavy part of the work. They load while this thread is idle, so every
// request waits for them first (only the first one has to).
const helpers = startHelpers();

scope.onmessage = async (event) => {
  await helpersReady(helpers);
  scope.postMessage(
    answerStrength(
      event.data,
      (progress) => scope.postMessage({ kind: "progress", progress }),
      lightTopology,
    ),
  );
};
