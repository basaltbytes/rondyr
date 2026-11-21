// architecture.md opens with a status block whose `**Production:**` line gives the address
// of the maintainers' own instance. The site documents Rondyr for people who deploy their
// own copy, so it leaves that line out.
import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";

import type { PhrasingContent, Root } from "mdast";

const label = "Production:";

/** Splits phrasing content into lines at the line breaks of its text nodes. */
function lines(children: readonly PhrasingContent[]): PhrasingContent[][] {
  const result: PhrasingContent[][] = [[]];
  for (const child of children) {
    if (child.type !== "text" || !child.value.includes("\n")) {
      result.at(-1)?.push(child);
      continue;
    }
    const [first = "", ...rest] = child.value.split("\n");
    if (first !== "") result.at(-1)?.push({ type: "text", value: first });
    for (const segment of rest) {
      result.push(segment === "" ? [] : [{ type: "text", value: segment }]);
    }
  }
  return result;
}

function isProductionLine(line: readonly PhrasingContent[]): boolean {
  const [first] = line;
  return first?.type === "strong" && toString(first).trim() === label;
}

/** A remark plugin that removes every line starting with `**Production:**` from a paragraph. */
export function remarkDropProductionLine() {
  return (tree: Root): void => {
    visit(tree, "paragraph", (paragraph) => {
      const split = lines(paragraph.children);
      if (!split.some(isProductionLine)) return;
      const kept = split.filter((line) => !isProductionLine(line));
      paragraph.children = kept.flatMap((line, index) =>
        index === 0 ? line : [{ type: "text" as const, value: "\n" }, ...line],
      );
    });
  };
}
