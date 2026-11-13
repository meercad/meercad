/** The Markdown our own notices use: headings, tables, lists, paragraphs and inline marks. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const show = (text: string) => render(<Markdown text={text} />).container;

afterEach(cleanup);

describe("Markdown", () => {
  it("renders headings one level down: # as h3, ## and ### as h4", () => {
    const page = show("# Title\n\n## Section\n\n### Detail");

    expect(page.querySelector("h3")!.textContent).toBe("Title");
    expect([...page.querySelectorAll("h4")].map((heading) => heading.textContent)).toEqual([
      "Section",
      "Detail",
    ]);
  });

  it("renders a table with its first row as the header, without the separator row", () => {
    const page = show("| Name | Licence |\n| --- | --- |\n| three | MIT |\n| occt | LGPL |");
    const rows = [...page.querySelectorAll("tr")];

    expect(rows).toHaveLength(3);
    expect([...rows[0]!.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["Name", "Licence"]);
    expect([...rows[2]!.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["occt", "LGPL"]);
  });

  it("renders a list, joining an indented line onto the item above it", () => {
    const page = show("- first\n- second\n  goes on\n- third\n\nAfter the list.");

    expect([...page.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "first",
      "second goes on",
      "third",
    ]);
    expect(page.querySelector("p")!.textContent).toBe("After the list.");
  });

  it("joins the lines of a paragraph with a space, and breaks after two trailing spaces", () => {
    const page = show("One line\nand the next.  \nA new line.\n\nSecond paragraph.");
    const paragraphs = [...page.querySelectorAll("p")];

    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.textContent).toBe("One line and the next.A new line.");
    expect(paragraphs[0]!.querySelectorAll("br")).toHaveLength(1);
  });

  it("renders code, bold, italic, named links and bare addresses", () => {
    const page = show(
      "Run `pnpm test`, it is **required**, _really_. See [the docs](https://example.org/docs) or https://example.org/x.",
    );

    expect(page.querySelector("code")!.textContent).toBe("pnpm test");
    expect(page.querySelector("b")!.textContent).toBe("required");
    expect(page.querySelector("em")!.textContent).toBe("really");

    const links = [...page.querySelectorAll("a")];

    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["the docs", "https://example.org/docs"],
      ["https://example.org/x.", "https://example.org/x."],
    ]);
    expect(links.every((link) => link.target === "_blank" && link.rel === "noreferrer")).toBe(true);
  });
});
