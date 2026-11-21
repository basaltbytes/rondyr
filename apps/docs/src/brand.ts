// The logo files in docs/brand/ switch to their dark colors with the operating system's
// color scheme. The header shows the wordmark as an image, and Safari draws an SVG image
// with the system's scheme even when the reader picked the other theme in the header.
// The build therefore writes a light and a dark copy of the wordmark, with the colors of
// each scheme fixed, for Starlight's `logo.light` and `logo.dark` options.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { repositoryPath } from "./repository/documents.ts";

export type ColorScheme = "light" | "dark";

/** The paths of the two copies of the wordmark. */
export interface LogoVariants {
  readonly light: string;
  readonly dark: string;
}

const darkBlock = /<style>\s*@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\}\s*<\/style>/u;

/** The SVG with the colors of one scheme, whatever the system's scheme. */
export function logoVariant(svg: string, scheme: ColorScheme): string {
  const match = darkBlock.exec(svg);
  if (match === null) {
    throw new Error(
      "The logo has no `@media (prefers-color-scheme: dark)` style block; update apps/docs/src/brand.ts.",
    );
  }
  return svg.replace(darkBlock, scheme === "light" ? "" : `<style>${match[1] ?? ""}</style>`);
}

/** Writes the light and dark copies of the wordmark into `directory` and returns their paths. */
export function writeLogoVariants(directory: URL): LogoVariants {
  const svg = readFileSync(repositoryPath("docs/brand/rondyr.svg"), "utf8");
  mkdirSync(directory, { recursive: true });
  const write = (scheme: ColorScheme): string => {
    const file = fileURLToPath(new URL(`rondyr-${scheme}.svg`, directory));
    writeFileSync(file, logoVariant(svg, scheme));
    return file;
  };
  return { light: write("light"), dark: write("dark") };
}
