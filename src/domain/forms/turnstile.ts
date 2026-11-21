import { Schema } from "effect";

export const turnstileField = "cf-turnstile-response";

// Cloudflare site keys can be interpolated in a quoted HTML attribute.
export const TurnstileSiteKey = Schema.Trim.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,256}$/u));
export type TurnstileSiteKey = typeof TurnstileSiteKey.Type;

export const SetTurnstile = Schema.Struct({
  siteKey: TurnstileSiteKey,
  secretKey: Schema.RedactedFromValue(Schema.Trim.check(Schema.isBetweenLength(1, 256))),
});

/**
 * What Siteverify says of a form's stored secret key when the owner looks at the
 * form. With a `refused` key (Siteverify no longer knows it) or an `unreadable`
 * one (it does not decrypt with the current `RONDYR_SECRETS_KEY`), intake cannot
 * verify tokens and lets messages go on to classification. `unchecked` means
 * Siteverify did not answer.
 */
export const TurnstileKeyState = Schema.Literals(["working", "refused", "unreadable", "unchecked"]);
export type TurnstileKeyState = typeof TurnstileKeyState.Type;

export const TurnstileKeyCheck = Schema.Struct({ state: TurnstileKeyState });

export const TurnstileToken = Schema.RedactedFromValue(
  Schema.String.check(Schema.isBetweenLength(1, 2048)),
);
export type TurnstileToken = typeof TurnstileToken.Type;
