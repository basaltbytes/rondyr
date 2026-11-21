import { getSecret } from "astro:env/server";

export interface RondyrSecrets {
  /** `RONDYR_API_TOKEN`: the Rondyr API token of the site's organization. */
  readonly token: string | null;
  /** `RONDYR_WEBHOOK_SECRET`: the signing secret of the Rondyr webhook destination. */
  readonly webhookSecret: string | null;
}

function present(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Both secrets are optional: a missing one disables what needs it, nothing else. */
export function rondyrSecrets(): RondyrSecrets {
  return {
    token: present(getSecret("RONDYR_API_TOKEN")),
    webhookSecret: present(getSecret("RONDYR_WEBHOOK_SECRET")),
  };
}
