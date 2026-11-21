import { Schema } from "effect";

import { PasswordResetRequestError } from "@rondyr/organizations/password-reset";

import type { Language } from "./language.ts";

const decodeError = Schema.decodeUnknownOption(PasswordResetRequestError);

/** A refused request, with the error that the API explains in its body, if any. */
export class PasswordResetFailed extends Schema.TaggedError<
  PasswordResetFailed,
  { readonly brand: unique symbol }
>()("PasswordResetFailed", {
  status: Schema.Int,
  problem: Schema.Option(PasswordResetRequestError),
}) {}

async function post(path: string, body: Readonly<Record<string, string>>) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return;
  const problem: unknown = await response.json().catch(() => null);
  throw PasswordResetFailed.make({ status: response.status, problem: decodeError(problem) });
}

/**
 * Ask for a reset link. The API answers the same whether an account has the
 * address or not.
 */
export async function requestPasswordReset(email: string, language: Language) {
  await post("/api/password-resets", { email, language });
}

/** Choose a new password with the secret of a link. The secret goes in the body, never in a URL. */
export async function completePasswordReset(token: string, password: string) {
  await post("/api/password-resets/complete", { token, password });
}
