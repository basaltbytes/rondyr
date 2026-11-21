import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";

import { addMember, seedAccount } from "../../tests/integration/member-fixture.ts";
import { call, createInbox, json, signIn } from "../../tests/integration/organization-fixture.ts";
import { routes } from "./routes.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

/**
 * Who may call a route. `public` needs no account, `account` a signed-in one.
 * The others are routes of an organization: `review` for any member, `admin`
 * for its admins only. `token` marks the routes that an API token may call.
 */
type Access = "public" | "account" | "review" | "admin";

interface Rights {
  readonly access: Access;
  readonly token?: true;
  /** A query string that the route decodes before it checks the account. */
  readonly query?: string;
}

/** A route, as `METHOD path`, and its rights. */
interface RouteRights extends Rights {
  readonly route: string;
}

const admin = { access: "admin" } satisfies Rights;

/**
 * Every route of the Worker. A route that is added without an entry here fails
 * the first assertion, and an `admin` route without a check of the role fails
 * the requests of the reviewer, of the outsider or of the token.
 */
const rights: ReadonlyArray<RouteRights> = [
  { route: "GET /health", access: "public" },
  { route: "POST /f/:formId", access: "public" },
  { route: "OPTIONS /f/:formId", access: "public" },
  { route: "GET /api/auth/get-session", access: "public" },
  { route: "POST /api/auth/sign-in/email", access: "public" },
  { route: "POST /api/auth/sign-out", access: "public" },
  { route: "POST /api/setup", access: "public" },
  { route: "POST /api/password-resets", access: "public" },
  { route: "POST /api/password-resets/complete", access: "public" },
  { route: "POST /api/invitations/read", access: "public" },
  { route: "POST /api/invitations/accept", access: "public" },
  { route: "POST /api/recipient-confirmations", access: "public" },
  { route: "GET /api/organizations", access: "account", token: true },
  { route: "POST /api/organizations", access: "account" },
  { route: "GET /api/operations", access: "account" },
  { route: "GET /api/organizations/:organizationId/submissions", access: "review", token: true },
  {
    route: "GET /api/organizations/:organizationId/submission-counts",
    access: "review",
    token: true,
  },
  {
    route: "GET /api/organizations/:organizationId/submissions/:submissionId",
    access: "review",
    token: true,
  },
  {
    route: "POST /api/organizations/:organizationId/submissions/:submissionId/:decision",
    access: "review",
    token: true,
  },
  {
    route: "GET /api/organizations/:organizationId/submissions/:submissionId/deliveries",
    access: "review",
  },
  {
    route:
      "POST /api/organizations/:organizationId/submissions/:submissionId/deliveries/:deliveryId/retry",
    ...admin,
  },
  { route: "DELETE /api/organizations/:organizationId/submissions/:submissionId", ...admin },
  {
    route: "GET /api/organizations/:organizationId/submission-export",
    ...admin,
    query: "format=csv",
  },
  { route: "GET /api/organizations/:organizationId/retention", ...admin },
  { route: "PUT /api/organizations/:organizationId/retention", ...admin },
  { route: "GET /api/organizations/:organizationId/members", ...admin },
  { route: "PATCH /api/organizations/:organizationId/members/:userId", ...admin },
  { route: "DELETE /api/organizations/:organizationId/members/:userId", ...admin },
  { route: "POST /api/organizations/:organizationId/invitations", ...admin },
  {
    route: "DELETE /api/organizations/:organizationId/invitations",
    ...admin,
    query: "id=73123ee4-40bf-4c5f-b8ff-1d56cdaa7641",
  },
  { route: "GET /api/organizations/:organizationId/api-tokens", ...admin },
  { route: "POST /api/organizations/:organizationId/api-tokens", ...admin },
  {
    route: "DELETE /api/organizations/:organizationId/api-tokens",
    ...admin,
    query: "id=example-token",
  },
  { route: "GET /api/organizations/:organizationId/domains", ...admin },
  { route: "POST /api/organizations/:organizationId/domains", ...admin },
  {
    route: "DELETE /api/organizations/:organizationId/domains",
    ...admin,
    query: "domain=example.com",
  },
  { route: "GET /api/organizations/:organizationId/classification-policy", ...admin },
  { route: "PUT /api/organizations/:organizationId/classification-policy", ...admin },
  { route: "DELETE /api/organizations/:organizationId/classification-policy", ...admin },
  { route: "GET /api/organizations/:organizationId/quotas", ...admin },
  { route: "PUT /api/organizations/:organizationId/quotas", ...admin },
  { route: "POST /api/organizations/:organizationId/forms", ...admin },
  { route: "PATCH /api/organizations/:organizationId/forms/:publicId", ...admin },
  { route: "POST /api/organizations/:organizationId/forms/:publicId/suspend", ...admin },
  { route: "POST /api/organizations/:organizationId/forms/:publicId/reactivate", ...admin },
  { route: "PUT /api/organizations/:organizationId/forms/:publicId/success-url", ...admin },
  { route: "DELETE /api/organizations/:organizationId/forms/:publicId/success-url", ...admin },
  { route: "PUT /api/organizations/:organizationId/forms/:publicId/honeypot", ...admin },
  { route: "DELETE /api/organizations/:organizationId/forms/:publicId/honeypot", ...admin },
  { route: "GET /api/organizations/:organizationId/forms/:publicId/turnstile", ...admin },
  { route: "PUT /api/organizations/:organizationId/forms/:publicId/turnstile", ...admin },
  { route: "DELETE /api/organizations/:organizationId/forms/:publicId/turnstile", ...admin },
  { route: "GET /api/organizations/:organizationId/forms/:publicId/origins", ...admin },
  { route: "POST /api/organizations/:organizationId/forms/:publicId/origins", ...admin },
  {
    route: "DELETE /api/organizations/:organizationId/forms/:publicId/origins",
    ...admin,
    query: "origin=https%3A%2F%2Fexample.com",
  },
  { route: "GET /api/organizations/:organizationId/forms/:publicId/targets", ...admin },
  { route: "POST /api/organizations/:organizationId/forms/:publicId/targets", ...admin },
  { route: "POST /api/organizations/:organizationId/targets/:targetId/rotate-secret", ...admin },
  { route: "PUT /api/organizations/:organizationId/targets/:targetId/recipients", ...admin },
  { route: "POST /api/organizations/:organizationId/targets/:targetId/confirmations", ...admin },
  { route: "POST /api/organizations/:organizationId/targets/:targetId/test", ...admin },
  { route: "POST /api/organizations/:organizationId/targets/:targetId/:action", ...admin },
];

/** The method and path of every route that the Worker registers. */
const registeredRoutes = Effect.gen(function* () {
  const registered: Array<string> = [];
  const recording = Layer.effect(HttpRouter.HttpRouter)(
    Effect.map(HttpRouter.make, (router): HttpRouter.HttpRouter => ({
      ...router,
      add: (method, path, handler, options) => {
        registered.push(`${method} ${path}`);
        return router.add(method, path, handler, options);
      },
    })),
  );
  // Building the router registers the routes; its handler is not needed here.
  yield* Effect.asVoid(HttpRouter.toHttpEffect(routes.pipe(Layer.provide(recording))));
  return registered;
}).pipe(Effect.scoped);

interface RouteStatus {
  readonly entry: RouteRights;
  readonly status: number;
}

/** The routes whose status breaks the rule, with their status. */
const breaking = (
  results: ReadonlyArray<RouteStatus>,
  rule: (entry: Rights, status: number) => boolean,
) =>
  results
    .filter(({ entry, status }) => !rule(entry, status))
    .map(({ entry, status }) => `${entry.route} ${status}`);

const inOrganization = ({ access }: Rights) => access === "review" || access === "admin";

const readToken = Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String }));

it.live(
  "lists every route with its rights, and enforces them for reviewers, outsiders and tokens",
  () =>
    Effect.gen(function* () {
      const registered = yield* registeredRoutes;
      assert.deepEqual(registered.toSorted(), rights.map(({ route }) => route).toSorted());

      const owner = yield* signIn;
      const { id, forms } = yield* createInbox("Route rights", owner);
      const form = forms[0];
      if (form === undefined) return assert.fail("Expected the contact form");
      const reviewer = yield* addMember(id, owner, "route-reviewer@example.test", "reviewer");
      const outsider = yield* seedAccount("route-outsider", "route-outsider@example.test");
      yield* createInbox("Route outsider", outsider);
      const created = yield* call(
        "POST",
        `/api/organizations/${id}/api-tokens`,
        { name: "Routes" },
        owner,
      );
      assert.strictEqual(created.status, 201);
      const { token } = yield* json(created).pipe(Effect.flatMap(readToken));
      const bearer = { authorization: `Bearer ${token}` };

      const samples = new Map([
        ["organizationId", id],
        ["publicId", form.publicId],
        ["formId", form.publicId],
        ["submissionId", "73123ee4-40bf-4c5f-b8ff-1d56cdaa7640"],
        ["deliveryId", "73123ee4-40bf-4c5f-b8ff-1d56cdaa7642"],
        ["targetId", "example-target"],
        ["userId", "example-user"],
        ["decision", "approve"],
        ["action", "activate"],
      ]);
      const urlOf = (path: string, query: string | undefined) => {
        const filled = path.replaceAll(/:(\w+)/gu, (_, name: string) => samples.get(name) ?? name);
        return query === undefined ? filled : `${filled}?${query}`;
      };
      /** The status of every API route for an identity, as `METHOD path status`. */
      // An account calls the routes that need one; the public routes would sign it
      // out or set up the first account. A token calls every API route.
      const statuses = Effect.fnUntraced(function* (
        headers: HeadersInit | undefined,
        reach: "account" | "api" = "account",
      ) {
        const result: Array<RouteStatus> = [];
        for (const entry of rights) {
          const [method = "", path = ""] = entry.route.split(" ");
          if (!path.startsWith("/api/")) continue;
          if (reach === "account" && entry.access === "public") continue;
          const response = yield* call(method, urlOf(path, entry.query), undefined, headers);
          result.push({ entry, status: response.status });
        }
        return result;
      });
      const asReviewer = yield* statuses(reviewer);
      const asOutsider = yield* statuses(outsider);
      const anonymous = yield* statuses(undefined);
      const asToken = yield* statuses(bearer, "api");

      // A reviewer gets 403 on every admin route, and is let through on a review
      // route: the sample message does not exist, so its detail is 404.
      assert.deepEqual(
        breaking(asReviewer, ({ access }, status) =>
          access === "admin"
            ? status === 403
            : access !== "review" || (status !== 401 && status !== 403),
        ),
        [],
      );
      // An account without a role in the organization gets 404 on all its routes.
      assert.deepEqual(
        breaking(asOutsider, (entry, status) => !inOrganization(entry) || status === 404),
        [],
      );
      assert.deepEqual(
        breaking(
          anonymous,
          (entry, status) =>
            (!inOrganization(entry) && entry.access !== "account") || status === 401,
        ),
        [],
      );
      // A token gets 403 on every API route outside its list, and is let through on it.
      assert.deepEqual(
        breaking(asToken, (entry, status) =>
          entry.token === true ? status !== 401 && status !== 403 : status === 403,
        ),
        [],
      );
    }),
  60_000,
);
