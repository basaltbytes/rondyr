import { Schema } from "effect";

export const turnstileField = "cf-turnstile-response";

// Cloudflare site keys can be interpolated in a quoted HTML attribute.
export const TurnstileSiteKey = Schema.Trim.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,256}$/u));
export type TurnstileSiteKey = typeof TurnstileSiteKey.Type;

export const SetTurnstile = Schema.Struct({
  siteKey: TurnstileSiteKey,
  secretKey: Schema.RedactedFromValue(Schema.Trim.check(Schema.isBetweenLength(1, 256))),
});

export const TurnstileToken = Schema.RedactedFromValue(
  Schema.String.check(Schema.isBetweenLength(1, 2048)),
);
export type TurnstileToken = typeof TurnstileToken.Type;
