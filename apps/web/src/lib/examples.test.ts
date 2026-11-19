/** The starter models: built in and from files, with their grey part colours. */
import { describe, expect, it } from "vitest";
import { EXAMPLE_GREYS, EXAMPLES, exampleGreys, fileExamples } from "./examples";

describe("examples", () => {
  it("gives the parts the grey tones in turn", () => {
    expect(exampleGreys("a", "b", "c", "d")).toEqual({
      a: EXAMPLE_GREYS[0],
      b: EXAMPLE_GREYS[1],
      c: EXAMPLE_GREYS[2],
      d: EXAMPLE_GREYS[0],
    });
  });

  it("reads the larger examples from their files and refuses a missing one", () => {
    const files = { "../examples/one.meercad": '{"format":"meercad/1","params":{},"features":[]}' };

    expect(fileExamples(files, [["one", "One", "The first"]])).toEqual([
      {
        name: "One",
        description: "The first",
        doc: { format: "meercad/1", params: {}, features: [] },
        feature: true,
      },
    ]);
    expect(() => fileExamples(files, [["two", "Two", ""]])).toThrow("example two is missing");
  });

  it("has every example under its own name, as a design", () => {
    expect(new Set(EXAMPLES.map((example) => example.name)).size).toBe(EXAMPLES.length);

    for (const example of EXAMPLES) expect(example.doc.format).toBe("meercad/1");
  });
});
