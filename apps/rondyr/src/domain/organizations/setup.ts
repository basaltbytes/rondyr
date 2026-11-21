import { Option, Schema } from "effect";

/**
 * The setup token is a secret of the Worker that whoever deploys Rondyr chooses. It is
 * the only way to create the first account, so that a stranger who finds the address of
 * a new instance first cannot claim it. A shorter token is refused.
 */
export const setupTokenLength = { minimum: 32 } as const;

/**
 * Whether the first account can be created:
 * - `open`: no account exists and the Worker has a setup token;
 * - `closed`: an account exists; the setup endpoint refuses every request;
 * - `token-missing`: no account exists and the Worker has no `RONDYR_SETUP_TOKEN`;
 * - `token-too-short`: the Worker's `RONDYR_SETUP_TOKEN` is shorter than the minimum.
 */
export const SetupState = Schema.Literals(["open", "closed", "token-missing", "token-too-short"]);
export type SetupState = typeof SetupState.Type;

/** The answer of `GET /api/setup`. */
export const SetupStatus = Schema.Struct({ state: SetupState });

/**
 * The setup state of an instance. Once an account exists, the answer says nothing about
 * the token, which the owner can then delete.
 */
export function setupState(accountExists: boolean, token: Option.Option<string>): SetupState {
  if (accountExists) return "closed";
  if (Option.isNone(token)) return "token-missing";
  return token.value.length < setupTokenLength.minimum ? "token-too-short" : "open";
}
