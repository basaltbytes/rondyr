import { decodePKIXECDSASignature, ECDSAPublicKey, p256 } from "@oslojs/crypto/ecdsa";
import { RSAPublicKey } from "@oslojs/crypto/rsa";
import {
  ClientDataType,
  coseAlgorithmEdDSA,
  coseAlgorithmES256,
  coseAlgorithmRS256,
  coseEllipticCurveEd25519,
  coseEllipticCurveP256,
  createAssertionSignatureMessage,
  parseAttestationObject,
  parseAuthenticatorData,
  parseClientDataJSON,
  type COSEPublicKey,
} from "@oslojs/webauthn";
import { Effect, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";

import type {
  PasskeyAssertionCredential,
  PasskeyRegistrationCredential,
} from "../../../domain/organizations/authentication.ts";
import { PasskeyInvalid } from "../../ports/authentication.ts";

const encodeTransports = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Public key algorithms advertised to authenticators during passkey creation. */
export const supportedPasskeyAlgorithms = [
  { type: "public-key" as const, alg: coseAlgorithmES256 },
  { type: "public-key" as const, alg: coseAlgorithmRS256 },
  { type: "public-key" as const, alg: coseAlgorithmEdDSA },
];

function decodeBase64Url(value: string): Effect.Effect<Uint8Array<ArrayBuffer>, PasskeyInvalid> {
  const decoded = Base64Url.decode(value);
  if (Result.isFailure(decoded)) return Effect.fail(PasskeyInvalid.make());
  // Copy into a standalone ArrayBuffer so Web Crypto accepts the view strictly.
  return Effect.succeed(new Uint8Array(decoded.success));
}

function encodeNormalizedPublicKey(
  publicKey: COSEPublicKey,
): Effect.Effect<{ readonly algorithm: number; readonly encoded: string }, PasskeyInvalid> {
  return Effect.try({
    try: () => {
      const algorithm = publicKey.algorithm();
      if (algorithm === coseAlgorithmES256) {
        const ec2 = publicKey.ec2();
        if (ec2.curve !== coseEllipticCurveP256) throw new Error("Unsupported EC2 curve");
        const sec1 = new ECDSAPublicKey(p256, ec2.x, ec2.y).encodeSEC1Uncompressed();
        return { algorithm, encoded: Base64Url.encode(sec1) };
      }
      if (algorithm === coseAlgorithmRS256) {
        const rsa = publicKey.rsa();
        const spki = new RSAPublicKey(rsa.n, rsa.e).encodePKIX();
        return { algorithm, encoded: Base64Url.encode(spki) };
      }
      if (algorithm === coseAlgorithmEdDSA) {
        const okp = publicKey.okp();
        if (okp.curve !== coseEllipticCurveEd25519 || okp.x.byteLength !== 32) {
          throw new Error("Unsupported OKP curve");
        }
        return { algorithm, encoded: Base64Url.encode(okp.x) };
      }
      throw new Error("Unsupported COSE algorithm");
    },
    catch: () => PasskeyInvalid.make(),
  });
}

/**
 * Parse and validate `clientDataJSON` for registration (`webauthn.create`), returning the
 * raw challenge bytes so the caller can consume the matching single-use challenge row.
 */
export const parseRegistrationClientData = Effect.fn("WebAuthn.parseRegistrationClientData")(
  function* (credential: PasskeyRegistrationCredential, expectedOrigin: string) {
    const clientDataBytes = yield* decodeBase64Url(credential.response.clientDataJSON);
    const clientData = yield* Effect.try({
      try: () => parseClientDataJSON(clientDataBytes),
      catch: () => PasskeyInvalid.make(),
    });
    if (
      clientData.type !== ClientDataType.Create ||
      clientData.origin !== expectedOrigin ||
      clientData.crossOrigin === true
    ) {
      return yield* PasskeyInvalid.make();
    }
    return new Uint8Array(clientData.challenge);
  },
);

export interface VerifiedPasskeyRegistration {
  readonly credentialId: string;
  readonly publicKey: string;
  readonly algorithm: number;
  readonly counter: number;
  readonly transports: string | null;
}

/** Verify a WebAuthn attestation object and extract the normalized public key. */
export const verifyRegistrationAttestation = Effect.fn("WebAuthn.verifyRegistrationAttestation")(
  function* (credential: PasskeyRegistrationCredential, expectedRpId: string) {
    if (credential.id !== credential.rawId) return yield* PasskeyInvalid.make();
    const attestationBytes = yield* decodeBase64Url(credential.response.attestationObject);
    const attestation = yield* Effect.try({
      try: () => parseAttestationObject(attestationBytes),
      catch: () => PasskeyInvalid.make(),
    });
    const { authenticatorData } = attestation;
    if (
      !authenticatorData.verifyRelyingPartyIdHash(expectedRpId) ||
      !authenticatorData.userPresent ||
      authenticatorData.credential === null
    ) {
      return yield* PasskeyInvalid.make();
    }
    const credentialId = Base64Url.encode(authenticatorData.credential.id);
    if (credentialId !== credential.id) return yield* PasskeyInvalid.make();
    const { algorithm, encoded: publicKey } = yield* encodeNormalizedPublicKey(
      authenticatorData.credential.publicKey,
    );
    const transports =
      credential.response.transports !== undefined && credential.response.transports.length > 0
        ? yield* encodeTransports(credential.response.transports).pipe(
            Effect.mapError(() => PasskeyInvalid.make()),
          )
        : null;
    return {
      credentialId,
      publicKey,
      algorithm,
      counter: authenticatorData.signatureCounter,
      transports,
    } satisfies VerifiedPasskeyRegistration;
  },
);

/**
 * Parse and validate `clientDataJSON` for assertion (`webauthn.get`), returning both the
 * raw challenge bytes and the original decoded `clientDataJSON` bytes for signature check.
 */
export const parseAssertionClientData = Effect.fn("WebAuthn.parseAssertionClientData")(function* (
  credential: PasskeyAssertionCredential,
  expectedOrigin: string,
) {
  if (credential.id !== credential.rawId) return yield* PasskeyInvalid.make();
  const clientDataBytes = yield* decodeBase64Url(credential.response.clientDataJSON);
  const clientData = yield* Effect.try({
    try: () => parseClientDataJSON(clientDataBytes),
    catch: () => PasskeyInvalid.make(),
  });
  if (
    clientData.type !== ClientDataType.Get ||
    clientData.origin !== expectedOrigin ||
    clientData.crossOrigin === true
  ) {
    return yield* PasskeyInvalid.make();
  }
  return {
    challenge: new Uint8Array(clientData.challenge),
    clientDataBytes,
  };
});

const verifySignatureWithWebCrypto = Effect.fnUntraced(function* (
  algorithm: number,
  publicKeyBytes: Uint8Array<ArrayBuffer>,
  signatureBytes: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
) {
  if (algorithm === coseAlgorithmES256) {
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "raw",
          publicKeyBytes,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        ),
      catch: () => PasskeyInvalid.make(),
    });
    const ieeeP1363 = yield* Effect.try({
      try: () => new Uint8Array(decodePKIXECDSASignature(signatureBytes).encodeIEEEP1363(p256)),
      catch: () => PasskeyInvalid.make(),
    });
    return yield* Effect.tryPromise({
      try: () => crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, ieeeP1363, message),
      catch: () => PasskeyInvalid.make(),
    });
  }
  if (algorithm === coseAlgorithmRS256) {
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "spki",
          publicKeyBytes,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      catch: () => PasskeyInvalid.make(),
    });
    return yield* Effect.tryPromise({
      try: () => crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signatureBytes, message),
      catch: () => PasskeyInvalid.make(),
    });
  }
  if (algorithm === coseAlgorithmEdDSA) {
    const key = yield* Effect.tryPromise({
      try: () => crypto.subtle.importKey("raw", publicKeyBytes, "Ed25519", false, ["verify"]),
      catch: () => PasskeyInvalid.make(),
    });
    return yield* Effect.tryPromise({
      try: () => crypto.subtle.verify("Ed25519", key, signatureBytes, message),
      catch: () => PasskeyInvalid.make(),
    });
  }
  return false;
});

/**
 * Verify a WebAuthn assertion's authenticatorData, signature counter, and Web Crypto signature.
 * Returns the updated signature counter to persist on the passkey row.
 */
export const verifyAssertionSignature = Effect.fn("WebAuthn.verifyAssertionSignature")(
  function* (input: {
    readonly credential: PasskeyAssertionCredential;
    readonly clientDataBytes: Uint8Array<ArrayBuffer>;
    readonly expectedRpId: string;
    readonly publicKey: string;
    readonly algorithm: number;
    readonly storedCounter: number;
  }) {
    const authDataBytes = yield* decodeBase64Url(input.credential.response.authenticatorData);
    const signatureBytes = yield* decodeBase64Url(input.credential.response.signature);
    const publicKeyBytes = yield* decodeBase64Url(input.publicKey);

    const authenticatorData = yield* Effect.try({
      try: () => parseAuthenticatorData(authDataBytes),
      catch: () => PasskeyInvalid.make(),
    });
    if (!authenticatorData.verifyRelyingPartyIdHash(input.expectedRpId)) {
      return yield* PasskeyInvalid.make();
    }
    if (!authenticatorData.userPresent) return yield* PasskeyInvalid.make();
    // WebAuthn §7.2 step 21: synced passkeys may keep counter = 0 on both sides; any non-zero
    // counter must strictly advance so cloned authenticators are refused.
    if (
      (input.storedCounter > 0 || authenticatorData.signatureCounter > 0) &&
      authenticatorData.signatureCounter <= input.storedCounter
    ) {
      return yield* PasskeyInvalid.make();
    }

    const message = new Uint8Array(
      createAssertionSignatureMessage(authDataBytes, input.clientDataBytes),
    );
    const valid = yield* verifySignatureWithWebCrypto(
      input.algorithm,
      publicKeyBytes,
      signatureBytes,
      message,
    );
    if (!valid) return yield* PasskeyInvalid.make();
    return authenticatorData.signatureCounter;
  },
);
