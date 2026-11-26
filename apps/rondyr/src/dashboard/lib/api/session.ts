import { queryOptions } from "@tanstack/react-query";
import { Option } from "effect";

import {
  AuthSession,
  EmailOtpError,
  PasskeyCreationOptions,
  PasskeyError,
  PasskeyRequestOptions,
  SessionResponse,
} from "@rondyr/organizations/authentication";
import { AuthStatus } from "@rondyr/organizations/setup";

import type { Language } from "~/lib/language";
import { assertBrowserPasskey, createBrowserPasskey } from "~/lib/webauthn";

import { refusalOf, request, requestJson } from "./request.ts";

/**
 * The signed-in account, or null for a visitor. The dashboard reads it once, and again
 * after a sign-in, a sign-out or an answer that says the session ended.
 */
export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: ({ signal }) =>
    requestJson("/api/auth/get-session", SessionResponse, { signal, cache: "no-store" }),
  staleTime: Number.POSITIVE_INFINITY,
});

/** Instance setup state and available sign-in / recovery methods. */
export const authStatusQuery = queryOptions({
  queryKey: ["auth-status"],
  queryFn: ({ signal }) =>
    requestJson("/api/auth/status", AuthStatus, { signal, cache: "no-store" }),
  staleTime: 0,
});

export async function signOutRequest() {
  await request("/api/auth/sign-out", { method: "POST", json: {} });
}

export async function signInWithPasskey() {
  const options = await requestJson("/api/auth/passkey/options", PasskeyRequestOptions, {
    method: "POST",
    json: {},
  });
  const credential = await assertBrowserPasskey(options);
  return requestJson("/api/auth/passkey/verify", AuthSession, {
    method: "POST",
    json: { credential },
  });
}

export async function requestEmailOtp(email: string, language: Language) {
  await request("/api/auth/otp/request", {
    method: "POST",
    json: { email, language },
    refusal: EmailOtpError,
  });
}

export async function verifyEmailOtp(email: string, code: string) {
  return requestJson("/api/auth/otp/verify", AuthSession, {
    method: "POST",
    json: { email, code },
    refusal: EmailOtpError,
  });
}

export function emailOtpErrorOf(cause: unknown) {
  return Option.getOrNull(Option.map(refusalOf(cause, EmailOtpError), ({ error }) => error));
}

export async function recoverWithPasskey(token: string, email: string) {
  const headers = { authorization: `Bearer ${token}` };
  const options = await requestJson("/api/auth/recovery/options", PasskeyCreationOptions, {
    method: "POST",
    headers,
    json: { email },
  });
  const credential = await createBrowserPasskey(options);
  return requestJson("/api/auth/recovery/verify", AuthSession, {
    method: "POST",
    headers,
    json: { credential },
    refusal: PasskeyError,
  });
}
