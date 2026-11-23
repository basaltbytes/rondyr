import favicon from "../../../../docs/brand/rondyr-favicon.svg?raw";

export function GET(): Response {
  return new Response(favicon, { headers: { "content-type": "image/svg+xml" } });
}
