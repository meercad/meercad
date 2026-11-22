/** The strength check and the topology suggestion run here, so the app stays responsive meanwhile. */
import { answerStrength, type StrengthRequest } from "@meercad/model";
import { lightSuggestion } from "./lib/strengthFinish";

const scope = self as unknown as {
  onmessage: (event: MessageEvent<StrengthRequest>) => void;
  postMessage(message: unknown): void;
};

scope.onmessage = (event) => {
  scope.postMessage(
    answerStrength(
      event.data,
      (progress) => scope.postMessage({ kind: "progress", progress }),
      lightSuggestion,
    ),
  );
};
