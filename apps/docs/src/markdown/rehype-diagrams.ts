// Renders fenced `mermaid` blocks to SVG at build time with Pele, as GitHub shows them as
// diagrams. An invalid diagram fails the build with the file and the position of the fence.
import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";
import { PeleError, render } from "pele";
import { visit } from "unist-util-visit";

import type { Element, Root } from "hast";
import type { VFile } from "vfile";

function isMermaidCode(node: Element["children"][number]): node is Element {
  if (node.type !== "element" || node.tagName !== "code") return false;
  const className = node.properties["className"];
  return Array.isArray(className) && className.includes("language-mermaid");
}

/** A rehype plugin that replaces each `mermaid` code block with its SVG diagram. */
export function rehypeDiagrams() {
  return (tree: Root, file: VFile): void => {
    let diagram = 0;
    visit(tree, "element", (node) => {
      if (node.tagName !== "pre") return;
      const code = node.children.find(isMermaidCode);
      if (code === undefined) return;
      diagram += 1;
      try {
        const { svg } = render(toString(code), {
          idPrefix: `diagram-${diagram}`,
          responsive: false,
          maxWidth: 600,
        });
        node.tagName = "div";
        node.properties = {
          className: ["diagram"],
          tabIndex: 0,
          role: "region",
          ariaLabel: `Diagram ${diagram}. Scroll horizontally to see all of it.`,
        };
        node.children = fromHtml(svg, { fragment: true }).children.filter(
          (child) => child.type === "element",
        );
      } catch (error) {
        if (!(error instanceof PeleError)) throw error;
        file.fail(`Pele: ${error.message}`, node.position);
      }
    });
  };
}
