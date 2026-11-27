// The landing page shows excerpts of the dashboard. Their colors are read from the dashboard's
// stylesheet at build time, so an excerpt keeps the dashboard's palette when the theme changes.

/** The color tokens of the dashboard that the excerpts use. */
export const dashboardTokens = [
  "background",
  "foreground",
  "card",
  "primary",
  "primary-foreground",
  "muted",
  "muted-foreground",
  "border",
  "input",
  "warning",
  "warning-subtle",
  "success",
  "success-subtle",
] as const;

function block(source: string, selector: string): string {
  const start = source.indexOf(`\n${selector} {\n`);
  const end = start === -1 ? -1 : source.indexOf("\n}", start);
  if (start === -1 || end === -1) {
    throw new Error(`The dashboard stylesheet has no "${selector}" block.`);
  }
  return source.slice(start, end);
}

function declarations(source: string, selector: string): string {
  const rules = block(source, selector);
  return dashboardTokens
    .map((token) => {
      const value = new RegExp(`^\\s*--${token}:\\s*([^;]+);`, "mu").exec(rules)?.[1];
      if (value === undefined) {
        throw new Error(`The "${selector}" block of the dashboard stylesheet has no --${token}.`);
      }
      return `--ui-${token}:${value.trim()}`;
    })
    .join(";");
}

/**
 * The CSS that gives an element with the `rondyr-ui` class the dashboard's light palette, and
 * its dark palette under the site's dark theme. Every token takes the `--ui-` prefix, so no
 * token replaces a variable of the site.
 */
export function dashboardThemeCss(source: string): string {
  const stylesheet = `\n${source}`;
  return [
    `.rondyr-ui{${declarations(stylesheet, ":root")}}`,
    `:root[data-theme="dark"] .rondyr-ui{${declarations(stylesheet, ".dark")}}`,
  ].join("\n");
}
