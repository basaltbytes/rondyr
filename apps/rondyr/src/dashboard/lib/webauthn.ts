import { Schema } from "effect";

import type {
  PasskeyAssertionCredential,
  PasskeyCreationOptions,
  PasskeyRegistrationCredential,
  PasskeyRequestOptions,
} from "@rondyr/organizations/authentication";

export const WebAuthnClientProblem = Schema.Literals([
  "unsupported",
  "cancelled",
  "exists",
  "failed",
]);
export type WebAuthnClientProblem = typeof WebAuthnClientProblem.Type;

export class WebAuthnClientError extends Schema.TaggedError<
  WebAuthnClientError,
  { readonly brand: unique symbol }
>()("WebAuthnClientError", {
  problem: WebAuthnClientProblem,
}) {}

export const isWebAuthnClientError = Schema.is(WebAuthnClientError);

const knownTransports: ReadonlyMap<string, AuthenticatorTransport> = new Map([
  ["ble", "ble"],
  ["hybrid", "hybrid"],
  ["internal", "internal"],
  ["nfc", "nfc"],
  ["usb", "usb"],
]);

function encodeBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function mapDomError(cause: unknown): WebAuthnClientError {
  if (isWebAuthnClientError(cause)) return cause;
  if (cause instanceof DOMException) {
    if (cause.name === "NotAllowedError" || cause.name === "AbortError") {
      return WebAuthnClientError.make({ problem: "cancelled" });
    }
    if (cause.name === "InvalidStateError") {
      return WebAuthnClientError.make({ problem: "exists" });
    }
  }
  return WebAuthnClientError.make({ problem: "failed" });
}

function toTransports(values: ReadonlyArray<string>): Array<AuthenticatorTransport> {
  const result: Array<AuthenticatorTransport> = [];
  for (const value of values) {
    const known = knownTransports.get(value);
    if (known !== undefined) result.push(known);
  }
  return result;
}

function isWebAuthnSupported(): boolean {
  return "PublicKeyCredential" in globalThis && navigator.credentials !== undefined;
}

/** Trigger the browser passkey creation prompt and serialize the credential for the Worker. */
export async function createBrowserPasskey(
  options: PasskeyCreationOptions,
): Promise<PasskeyRegistrationCredential> {
  if (!isWebAuthnSupported()) {
    throw WebAuthnClientError.make({ problem: "unsupported" });
  }
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: decodeBase64Url(options.challenge),
    rp: { name: options.rp.name, id: options.rp.id },
    user: {
      id: decodeBase64Url(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    pubKeyCredParams: options.pubKeyCredParams.map(({ type, alg }) => ({ type, alg })),
    timeout: options.timeout,
    attestation: options.attestation,
    authenticatorSelection: {
      residentKey: options.authenticatorSelection.residentKey,
      requireResidentKey: options.authenticatorSelection.requireResidentKey,
      userVerification: options.authenticatorSelection.userVerification,
    },
    ...(options.excludeCredentials !== undefined && {
      excludeCredentials: options.excludeCredentials.map(({ id, type, transports }) => ({
        id: decodeBase64Url(id),
        type,
        ...(transports !== undefined && { transports: toTransports(transports) }),
      })),
    }),
  };
  let created: Credential | null;
  try {
    created = await navigator.credentials.create({ publicKey });
  } catch (cause) {
    throw mapDomError(cause);
  }
  if (!(created instanceof PublicKeyCredential)) {
    throw WebAuthnClientError.make({ problem: "failed" });
  }
  const response = created.response;
  if (!(response instanceof AuthenticatorAttestationResponse)) {
    throw WebAuthnClientError.make({ problem: "failed" });
  }
  const transports = response.getTransports?.() ?? [];
  return {
    id: created.id,
    rawId: encodeBase64Url(created.rawId),
    type: "public-key",
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      attestationObject: encodeBase64Url(response.attestationObject),
      ...(transports.length > 0 && { transports }),
    },
  };
}

/** Trigger the browser discoverable passkey sign-in prompt and serialize the assertion. */
export async function assertBrowserPasskey(
  options: PasskeyRequestOptions,
): Promise<PasskeyAssertionCredential> {
  if (!isWebAuthnSupported()) {
    throw WebAuthnClientError.make({ problem: "unsupported" });
  }
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: decodeBase64Url(options.challenge),
    rpId: options.rpId,
    timeout: options.timeout,
    userVerification: options.userVerification,
    allowCredentials: options.allowCredentials.map(({ id, type, transports }) => ({
      id: decodeBase64Url(id),
      type,
      ...(transports !== undefined && { transports: toTransports(transports) }),
    })),
  };
  let asserted: Credential | null;
  try {
    asserted = await navigator.credentials.get({ publicKey });
  } catch (cause) {
    throw mapDomError(cause);
  }
  if (!(asserted instanceof PublicKeyCredential)) {
    throw WebAuthnClientError.make({ problem: "failed" });
  }
  const response = asserted.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) {
    throw WebAuthnClientError.make({ problem: "failed" });
  }
  return {
    id: asserted.id,
    rawId: encodeBase64Url(asserted.rawId),
    type: "public-key",
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      authenticatorData: encodeBase64Url(response.authenticatorData),
      signature: encodeBase64Url(response.signature),
      userHandle: response.userHandle === null ? null : encodeBase64Url(response.userHandle),
    },
  };
}
