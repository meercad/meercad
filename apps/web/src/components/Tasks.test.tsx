/**
 * What the app is busy with (Tasks.tsx): a task shows only once it has run a moment; it shows its
 * detail, percent and a stop button; a long task counts its time and, with progress, says about how
 * long is left; when the last one ends the bar goes.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, describe, expect, it } from "vitest";
import { startTask, useApp } from "../store";
import { Tasks } from "./Tasks";

const settle = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));
afterAll(() => {
  useApp.setState({ tasks: [] });
  cleanup();
});

describe("the busy bar", () => {
  it("shows a task after a moment, with detail, percent and a stop button", async () => {
    let stopped = false;
    render(<Tasks />);
    let task!: ReturnType<typeof startTask>;
    await act(async () => void (task = startTask("Reading part.step", 0.25, { cancel: () => void (stopped = true) })));
    expect(document.querySelector(".tasks")).toBeNull();
    await settle(420);
    expect(screen.getByText("Reading part.step")).toBeTruthy();
    expect(screen.getByText("25 %")).toBeTruthy();
    await act(async () => task.update(0.5, "faces"));
    expect(screen.getByText("faces")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByTitle("Stop")));
    expect(stopped).toBe(true);
    await act(async () => task.done());
    expect(document.querySelector(".tasks")).toBeNull();
  });

  it("counts a long task's time and says about how long is left", async () => {
    const now = performance.now();
    await act(async () =>
      useApp.setState({
        tasks: [
          { id: 901, label: "Model from photos", progress: null, since: now - 75_000, long: true },
          { id: 902, label: "Meshing", progress: 0.5, since: now - 200_000, long: true, progressFrom: now - 200_000, progressLog: [[0, 0], [100, 0.25], [200, 0.5]] } as never,
          { id: 903, label: "Almost", progress: 0.95, since: now - 200_000, long: true, progressFrom: now - 200_000, progressLog: [[0, 0], [100, 0.5], [200, 0.95]] } as never,
        ],
      }),
    );
    await settle(1100);
    const times = [...document.querySelectorAll(".task-time")].map((e) => e.textContent);
    expect(times[0]).toMatch(/^1:1\d so far$/);
    expect(times[1]).toMatch(/so far · about \d+ min left/);
    expect(times[2]).toMatch(/less than a minute left/);
    expect(document.querySelector(".task-bar.indeterminate")).not.toBeNull();
  });
});
