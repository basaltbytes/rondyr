// Serves the Rondyr mark from docs/brand/ as the favicon, so the site has no copy of it.
import mark from "../../../../docs/brand/rondyr-mark.svg?raw";

export function GET(): Response {
  return new Response(mark, { headers: { "content-type": "image/svg+xml" } });
}
