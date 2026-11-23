import { PasswordResetRequestError } from "@rondyr/organizations/password-reset";

import type { Language } from "~/lib/language";

import { refusalOf, request } from "./request.ts";

/** The reason that the password reset API gave for a refusal, if any. */
export function passwordResetRefusalOf(cause: unknown) {
  return refusalOf(cause, PasswordResetRequestError);
}

/**
 * Ask for a reset link. The API answers the same whether an account has the address or
 * not.
 */
export async function requestPasswordReset(email: string, language: Language) {
  await request("/api/password-resets", {
    method: "POST",
    json: { email, language },
    refusal: PasswordResetRequestError,
  });
}

/** Choose a new password with the secret of a link. The secret goes in the body, never in a URL. */
export async function completePasswordReset(token: string, password: string) {
  await request("/api/password-resets/complete", {
    method: "POST",
    json: { token, password },
    refusal: PasswordResetRequestError,
  });
}
