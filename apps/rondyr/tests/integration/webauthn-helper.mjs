// Pure Web Crypto P-256 WebAuthn test authenticator for integration tests and local scripts.
// Uses only standard Web Crypto APIs so it runs identically in workerd and Node 24.

const encoder = new TextEncoder();

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64Url(value) {
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concat(...arrays) {
  const total = arrays.reduce((sum, array) => sum + array.byteLength, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.byteLength;
  }
  return out;
}

function uint32BE(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function uint16BE(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function cborBytes(bytes) {
  const length = bytes.byteLength;
  if (length < 24) return concat(new Uint8Array([0x40 + length]), bytes);
  if (length < 256) return concat(new Uint8Array([0x58, length]), bytes);
  return concat(new Uint8Array([0x59, (length >> 8) & 0xff, length & 0xff]), bytes);
}

function cborText(value) {
  const bytes = encoder.encode(value);
  return concat(new Uint8Array([0x60 + bytes.byteLength]), bytes);
}

/** Encode a P-256 public key (x, y) as a CBOR COSE_Key map with alg ES256 (-7). */
function encodeCoseP256Key(x, y) {
  return concat(
    new Uint8Array([0xa5]),
    // 1 (kty): 2 (EC2)
    new Uint8Array([0x01, 0x02]),
    // 3 (alg): -7 (ES256)
    new Uint8Array([0x03, 0x26]),
    // -1 (crv): 1 (P-256)
    new Uint8Array([0x20, 0x01]),
    // -2 (x): bstr(32)
    new Uint8Array([0x21]),
    cborBytes(x),
    // -3 (y): bstr(32)
    new Uint8Array([0x22]),
    cborBytes(y),
  );
}

function encodeDerInteger(bytes) {
  let start = 0;
  while (start < bytes.byteLength - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.slice(start);
  const needsLeadingZero = (trimmed[0] ?? 0) >= 0x80;
  const payload = needsLeadingZero ? concat(new Uint8Array([0x00]), trimmed) : trimmed;
  return concat(new Uint8Array([0x02, payload.byteLength]), payload);
}

function encodeDerEcdsaSignature(ieeeP1363) {
  const r = encodeDerInteger(ieeeP1363.slice(0, 32));
  const s = encodeDerInteger(ieeeP1363.slice(32, 64));
  return concat(new Uint8Array([0x30, r.byteLength + s.byteLength]), r, s);
}

/** Generate a fresh P-256 passkey and sign a WebAuthn registration payload for `options`. */
export async function registerVirtualPasskey(options, origin, overrides = {}) {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  if (jwk.x === undefined || jwk.y === undefined) throw new Error("Expected P-256 JWK coordinates");
  const x = decodeBase64Url(jwk.x);
  const y = decodeBase64Url(jwk.y);
  const publicKeyCose = encodeCoseP256Key(x, y);

  const credentialIdBytes = new Uint8Array(new ArrayBuffer(32));
  crypto.getRandomValues(credentialIdBytes);
  const credentialId = encodeBase64Url(credentialIdBytes);

  const rpId = overrides.rpId ?? options.rp.id;
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(rpId)));
  const flags =
    (overrides.userPresent === false ? 0x00 : 0x01) |
    (overrides.userVerified === false ? 0x00 : 0x04) |
    0x40;
  const initialCounter = overrides.counter ?? 0;
  const aaguid = new Uint8Array(16);
  const authData = concat(
    rpIdHash,
    new Uint8Array([flags]),
    uint32BE(initialCounter),
    aaguid,
    uint16BE(credentialIdBytes.byteLength),
    credentialIdBytes,
    publicKeyCose,
  );
  const attestationObject = concat(
    new Uint8Array([0xa3]),
    cborText("fmt"),
    cborText("none"),
    cborText("attStmt"),
    new Uint8Array([0xa0]),
    cborText("authData"),
    cborBytes(authData),
  );
  const clientDataJSON = encoder.encode(
    JSON.stringify({
      type: "webauthn.create",
      challenge: overrides.challenge ?? options.challenge,
      origin: overrides.origin ?? origin,
      crossOrigin: false,
    }),
  );

  const passkey = {
    credentialId,
    credentialIdBytes,
    publicKeyCose,
    privateKey: keyPair.privateKey,
    rpId,
    userHandle: options.user.id,
    counter: initialCounter,
  };
  const credential = {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    response: {
      clientDataJSON: encodeBase64Url(clientDataJSON),
      attestationObject: encodeBase64Url(attestationObject),
      transports: ["internal"],
    },
  };
  return { passkey, credential };
}

/** Sign a WebAuthn assertion payload using an existing virtual passkey. */
export async function assertVirtualPasskey(passkey, options, origin, overrides = {}) {
  const nextCounter = overrides.counter ?? passkey.counter + 1;
  if (overrides.counter === undefined) passkey.counter = nextCounter;
  const rpId = overrides.rpId ?? options.rpId;
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(rpId)));
  const flags = overrides.userVerified === false ? 0x01 : 0x05;
  const authData = concat(rpIdHash, new Uint8Array([flags]), uint32BE(nextCounter));
  const clientDataJSON = encoder.encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: overrides.challenge ?? options.challenge,
      origin: overrides.origin ?? origin,
      crossOrigin: overrides.crossOrigin ?? false,
    }),
  );
  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
  const signedData = concat(authData, clientDataHash);
  const rawSignature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, passkey.privateKey, signedData),
  );
  if (overrides.tamperSignature === true) {
    rawSignature[0] = (rawSignature[0] ?? 0) ^ 0xff;
  }
  const derSignature = encodeDerEcdsaSignature(rawSignature);
  return {
    id: passkey.credentialId,
    rawId: passkey.credentialId,
    type: "public-key",
    response: {
      clientDataJSON: encodeBase64Url(clientDataJSON),
      authenticatorData: encodeBase64Url(authData),
      signature: encodeBase64Url(derSignature),
      userHandle: passkey.userHandle,
    },
  };
}
