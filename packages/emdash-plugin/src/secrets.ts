import { getSecret } from "astro:env/server";

import { readSecrets, type RondyrSecrets } from "./core/secrets.ts";

/** `RONDYR_API_TOKEN` and `RONDYR_WEBHOOK_SECRET`, read through `astro:env/server`. */
export function rondyrSecrets(): RondyrSecrets {
  return readSecrets(getSecret("RONDYR_API_TOKEN"), getSecret("RONDYR_WEBHOOK_SECRET"));
}
