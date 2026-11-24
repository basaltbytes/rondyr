import { env } from "cloudflare:workers";
import { assert } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { InboxOrganizationWithForms } from "../../src/domain/submissions/inbox-setup.ts";
import { testOrigin as origin, testSetupToken } from "./auth-fixture.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const readInboxes = Schema.decodeUnknownEffect(Schema.Array(InboxOrganizationWithForms));
export const json = (response: Response) => Effect.promise(() => response.json());

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

export const signIn = Effect.runSync(
  Effect.cached(
    Effect.gen(function* () {
      const credentials = {
        email: "settings-admin@example.test",
        password: "settings-admin-test-password",
      };
      const setup = yield* call(
        "POST",
        "/api/setup",
        { name: "Settings admin", ...credentials },
        {
          authorization: `Bearer ${testSetupToken}`,
        },
      );
      assert.strictEqual(setup.status, 201);
      const session = yield* call("POST", "/api/auth/sign-in/email", credentials);
      assert.strictEqual(session.status, 200);
      const cookie = session.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
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
