// The address of the documentation site comes from one setting, RONDYR_DOCS_URL: the
// repository variable in GitHub Actions, or the environment of a local build.

/** The address of `astro preview`, used when RONDYR_DOCS_URL is unset. */
export const defaultSiteUrl = "http://localhost:4321";

/**
 * The origin of the site, from the value of RONDYR_DOCS_URL. The site is served at the root
 * of its host, so the value is an origin such as `https://docs.example.com`, with no path.
 */
export function siteUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return defaultSiteUrl;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`RONDYR_DOCS_URL must be a URL such as https://docs.example.com: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`RONDYR_DOCS_URL must use HTTPS: ${value}`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`RONDYR_DOCS_URL must be an origin, with no path: ${value}`);
  }
  return url.origin;
}
