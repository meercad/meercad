/**
 * Our notices' Markdown (Markdown.tsx): headings, tables (the dash row left out), lists with lines
 * running on, paragraphs joined or broken after two spaces, and `code`, bold, italic, links and bare
 * addresses inline.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

afterEach(cleanup);

describe("our notices' Markdown", () => {
  it("renders headings, tables, lists, paragraphs and inline marks", () => {
    const text = [
      "# Title",
      "## Part",
      "",
      "| Name | Licence |",
      "| --- | --- |",
      "| `three` | **MIT** |",
      "",
      "- one",
      "  goes on",
      "- two _slanted_",
      "",
      "First line  ",
      "second line",
      "third, see [the site](https://example.org) or https://meercad.app.",
    ].join("\n");
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelector("h3")!.textContent).toBe("Title");
    expect(container.querySelector("h4")!.textContent).toBe("Part");
    expect([...container.querySelectorAll("tr")].map((r) => r.textContent)).toEqual(["NameLicence", "threeMIT"]);
    expect(container.querySelector("th")).not.toBeNull();
    expect(container.querySelector("td code")!.textContent).toBe("three");
    expect(container.querySelector("td b")!.textContent).toBe("MIT");
    expect([...container.querySelectorAll("li")].map((l) => l.textContent)).toEqual(["one goes on", "two slanted"]);
    expect(container.querySelector("li em")!.textContent).toBe("slanted");
    const p = container.querySelector("p")!;
    expect(p.querySelectorAll("br")).toHaveLength(1);
    expect(p.textContent).toContain("second line third");
    const links = [...p.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([["the site", "https://example.org"], ["https://meercad.app.", "https://meercad.app."]]);
  });
});
