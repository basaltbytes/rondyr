import { env } from "cloudflare:workers";
import { assert } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import {
  PasskeyCreationOptions,
  PasskeyRequestOptions,
} from "../../src/domain/organizations/authentication.ts";
import { InboxOrganizationWithForms } from "../../src/domain/submissions/inbox-setup.ts";
import { Authentication } from "../../src/worker/ports/authentication.ts";
import { testOrigin as origin, testSetupToken } from "./auth-fixture.ts";
import {
  assertVirtualPasskey,
  registerVirtualPasskey,
  type VirtualPasskey,
} from "./webauthn-helper.mjs";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const readInboxes = Schema.decodeUnknownEffect(Schema.Array(InboxOrganizationWithForms));
const readCreationOptions = Schema.decodeUnknownEffect(PasskeyCreationOptions);
const readRequestOptions = Schema.decodeUnknownEffect(PasskeyRequestOptions);
export const json = (response: Response) => Effect.promise(() => response.json());

export const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");

/** Send a request from the test origin, to the test Worker unless another one is given. */
export const call = Effect.fnUntraced(function* (
  method: string,
  path: string,
  data?: Schema.Json,
  extra?: HeadersInit,
  worker: Fetcher = env.TEST_WORKER,
) {
  const headers = new Headers(extra);
  headers.set("origin", origin);
  const url = new URL(path, origin);
  if (data === undefined)
    return yield* Effect.promise(() => worker.fetch(url, { method, headers }));
  headers.set("content-type", "application/json");
  const body = yield* encode(data);
  return yield* Effect.promise(() => worker.fetch(url, { method, headers, body }));
});

/** Send a JSON request with the `Origin` of another site, as its page could with a no-cors `fetch`. */
export const callFromOtherSite = Effect.fnUntraced(function* (
  path: string,
  data: Schema.Json,
  extra?: HeadersInit,
) {
  const headers = new Headers(extra);
  headers.set("origin", "https://attacker.example");
  headers.set("content-type", "application/json");
  const body = yield* encode(data);
  return yield* Effect.promise(() =>
    env.TEST_WORKER.fetch(new URL(path, origin), { method: "POST", headers, body }),
  );
});

/** Complete atomic passkey owner setup on `worker`, returning the session cookie and passkey. */
export const setupOwner = Effect.fnUntraced(function* (
  owner: { readonly name: string; readonly email: string },
  options: {
    readonly worker?: Fetcher;
    readonly token?: string;
    readonly requestOrigin?: string;
  } = {},
) {
  const targetWorker = options.worker ?? env.TEST_WORKER;
  const requestOrigin = options.requestOrigin ?? origin;
  const authHeader = { authorization: `Bearer ${options.token ?? testSetupToken}` };
  const optionsResponse = yield* call(
    "POST",
    "/api/setup/options",
    { name: owner.name, email: owner.email },
    authHeader,
    targetWorker,
  );
  assert.strictEqual(optionsResponse.status, 200);
  const creationOptions = yield* json(optionsResponse).pipe(Effect.flatMap(readCreationOptions));
  const { passkey, credential } = yield* Effect.promise(() =>
    registerVirtualPasskey(creationOptions, requestOrigin),
  );
  const verifyResponse = yield* call(
    "POST",
    "/api/setup/verify",
    { credential },
    authHeader,
    targetWorker,
  );
  assert.strictEqual(verifyResponse.status, 201);
  return { cookie: cookieOf(verifyResponse), passkey };
});

/** Sign in with an existing virtual passkey on `worker`, returning the session cookie header. */
export const signInWithPasskey = Effect.fnUntraced(function* (
  passkey: VirtualPasskey,
  options: {
    readonly worker?: Fetcher;
    readonly requestOrigin?: string;
    readonly clientIp?: string;
  } = {},
) {
  const targetWorker = options.worker ?? env.TEST_WORKER;
  const requestOrigin = options.requestOrigin ?? origin;
  const extra =
    options.clientIp === undefined ? undefined : { "cf-connecting-ip": options.clientIp };
  const optionsResponse = yield* call("POST", "/api/auth/passkey/options", {}, extra, targetWorker);
  assert.strictEqual(optionsResponse.status, 200);
  const requestOptions = yield* json(optionsResponse).pipe(Effect.flatMap(readRequestOptions));
  const credential = yield* Effect.promise(() =>
    assertVirtualPasskey(passkey, requestOptions, requestOrigin),
  );
  const verifyResponse = yield* call(
    "POST",
    "/api/auth/passkey/verify",
    { credential },
    extra,
    targetWorker,
  );
  assert.strictEqual(verifyResponse.status, 200);
  return { cookie: cookieOf(verifyResponse) };
});

export const signIn = Effect.runSync(
  Effect.cached(
    Effect.gen(function* () {
      const { cookie } = yield* setupOwner({
        name: "Settings admin",
        email: "settings-admin@example.test",
      });
      return { cookie };
    }),
  ),
);

export const createInbox = Effect.fnUntraced(function* (
  organizationName: string,
  headers: HeadersInit,
  businessContext = "",
) {
  const created = yield* call(
    "POST",
    "/api/organizations",
    { organizationName, formName: "Contact", businessContext },
    headers,
  );
  assert.strictEqual(created.status, 201);
  const inboxes = yield* call("GET", "/api/organizations", undefined, headers).pipe(
    Effect.flatMap(json),
    Effect.flatMap(readInboxes),
  );
  const inbox = inboxes.find(({ name }) => name === organizationName);
  if (inbox === undefined) return assert.fail("Expected the new organization");
  return inbox;
});

const unexpectedAuthCall = () => Effect.die("Unexpected Authentication call in route unit test");

/** Test-only Authentication layer for route tests that exercise only `userId`. */
export function fakeAuthentication(userIdOf: (request: Request) => string | null) {
  return Layer.succeed(Authentication, {
    userId: (request) => Effect.succeed(userIdOf(request)),
    verifyOrigin: unexpectedAuthCall,
    getSession: unexpectedAuthCall,
    signOut: unexpectedAuthCall,
    authStatus: unexpectedAuthCall(),
    setupOptions: unexpectedAuthCall,
    setupVerify: unexpectedAuthCall,
    passkeySignInOptions: unexpectedAuthCall,
    passkeySignInVerify: unexpectedAuthCall,
    issueEmailOtp: unexpectedAuthCall,
    verifyEmailOtp: unexpectedAuthCall,
    recoveryOptions: unexpectedAuthCall,
    recoveryVerify: unexpectedAuthCall,
    invitationOptions: unexpectedAuthCall,
    invitationVerify: unexpectedAuthCall,
    listPasskeys: unexpectedAuthCall,
    addPasskeyOptions: unexpectedAuthCall,
    addPasskeyVerify: unexpectedAuthCall,
    renamePasskey: unexpectedAuthCall,
    deletePasskey: unexpectedAuthCall,
    purgeExpired: unexpectedAuthCall,
  });
}
