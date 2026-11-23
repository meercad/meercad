/**
 * A helper thread of the strength calculation: it shares the memory of the thread that calculates
 * and does its part of the cube-by-cube work there (see packages/model/src/fem/shared.ts).
 */
import { helperLoop } from "@meercad/model";

const scope = self as unknown as {
  onmessage: (event: MessageEvent<{ memory: SharedArrayBuffer; helper: number }>) => void;
};

scope.onmessage = (event) => helperLoop(event.data.memory, event.data.helper);
