import { fileURLToPath } from "node:url";

// Workers AI for the tests. Jev answers by the `fixture-verdict` field of the
// submission: `accept` gets low spam and solicitation scores, `solicitation` a
// low spam score and a solicitation score above the threshold,
// `ambiguous-solicitation` the same with an ambiguous spam score, and
// `missing-solicitation` a low spam score without the solicitation answer. The
// relevance score is high, or low when the business context contains
// `fixture-relevance: low`. Any other request gets an answer that does not
// decode, so the classifier quarantines it with `classification-error`, as it
// does without an AI binding. Tests can read the fields or the complete
// classifier inputs from GET /__calls or GET /__states.
const workersAiFixture = `
const calls = [];
const verdicts = new Map([
  ["accept", { spam: 0.02, solicitation: 0.03 }],
  ["solicitation", { spam: 0.02, solicitation: 0.93 }],
  ["ambiguous-solicitation", { spam: 0.3, solicitation: 0.93 }],
  ["missing-solicitation", { spam: 0.02 }],
]);
export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/__calls") return Response.json(calls.map((state) => state?.submission_fields ?? null));
    if (path === "/__states") return Response.json(calls);
    if (path !== "/ai-gateway/run") return new Response(null, { status: 404 });
    const model = request.headers.get("cf-consn-model-id");
    const { inputs: input } = await request.json();
    calls.push(input?.state ?? null);
    const verdict = verdicts.get(input?.state?.submission_fields?.["fixture-verdict"]);
    if (model !== "typesafe/jev" || verdict === undefined) return Response.json({});
    const relevance = input.state.business_context.includes("fixture-relevance: low") ? 0.05 : 0.98;
    const scores = { ...verdict, relevance };
    const answers = Object.fromEntries(
      Object.keys(input.questions)
        .filter((question) => scores[question] !== undefined)
        .map((question) => [question, { type: "noul", noul: scores[question] }]),
    );
    return Response.json({ model: "workerd-fixture", answers });
  },
};
`;

// A webhook recipient for the tests. It records every request, which tests read
// back from GET /__received?prefix=..., and answers by the last path segment:
// ok (204), fail-once (500, then 200), bad-request-once (400, then 204),
// bad-request (400), redirect (307 to ok).
// The test Worker's outbound fetch goes here, whatever the hostname. Requests to
// api.resend.com go on to the Resend fixture.
const webhookReceiverFixture = `
const received = [];
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "api.resend.com") return env.RESEND.fetch(request);
    if (url.hostname === "challenges.cloudflare.com") return env.SITEVERIFY.fetch(request);
    if (url.pathname === "/__received") {
      const prefix = url.searchParams.get("prefix") ?? "/";
      return Response.json(received.filter((entry) => entry.path.startsWith(prefix)));
    }
    received.push({
      url: url.href,
      path: url.pathname,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    });
    const calls = received.filter((entry) => entry.path === url.pathname).length;
    switch (url.pathname.split("/").at(-1)) {
      case "ok":
        return new Response(null, { status: 204 });
      case "fail-once":
        return calls === 1
          ? new Response("Recipient body that Rondyr must not store", { status: 500 })
          : new Response("ok", { status: 200 });
      case "bad-request-once":
        return new Response(null, { status: calls === 1 ? 400 : 204 });
      case "bad-request":
        return new Response("Recipient body that Rondyr must not store", { status: 400 });
      case "redirect":
        return new Response(null, { status: 307, headers: { location: new URL("ok", url).href } });
      default:
        return new Response(null, { status: 404 });
    }
  },
};
`;

// Siteverify for the tests. It records every call, which tests read back from
// GET /__calls?secret=..., and answers by the secret key first: refused-<name>
// is an unknown key (HTTP 400 with invalid-input-secret, as Cloudflare answers),
// unreachable-<name> gets 503 and internal-error-<name> an internal-error reply.
// Any other secret key is known and accepts only the token "valid-<secret>". The
// token unavailable gets 503, and the token slow an answer after 15 seconds.
const siteverifyFixture = `
const calls = [];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__calls") {
      return Response.json(calls.filter(({ secret }) => secret === url.searchParams.get("secret")));
    }
    if (request.method !== "POST" || url.pathname !== "/turnstile/v0/siteverify") {
      return new Response(null, { status: 404 });
    }
    const body = await request.formData();
    const secret = body.get("secret");
    const token = body.get("response");
    calls.push({ secret, token });
    if (secret.startsWith("refused-")) {
      return Response.json({ success: false, "error-codes": ["invalid-input-secret"] }, { status: 400 });
    }
    if (secret.startsWith("internal-error-")) {
      return Response.json({ success: false, "error-codes": ["internal-error"] });
    }
    if (secret.startsWith("unreachable-") || token === "unavailable") {
      return new Response(null, { status: 503 });
    }
    if (token === "slow") await scheduler.wait(15_000);
    return token === "valid-" + secret
      ? Response.json({ success: true })
      : Response.json({ success: false, "error-codes": ["invalid-input-response"] });
  },
};
`;

// The Resend API for the tests. It records every POST /emails, which tests read
// back from GET /__received?recipient=..., and answers by the local part of the
// first recipient: once-<status> answers <status> to the first request with an
// idempotency key and 200 to the next ones, always-<status> answers <status>
// every time, and any other address gets 200. Error bodies have the shape that
// https://resend.com/docs/api-reference/errors documents.
const resendFixture = `
const received = [];
const names = {
  400: "validation_error",
  401: "missing_api_key",
  403: "validation_error",
  409: "concurrent_idempotent_requests",
  422: "validation_error",
  429: "rate_limit_exceeded",
  500: "application_error",
};
const recipientsOf = (entry) => JSON.parse(entry.body).to ?? [];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__received") {
      const recipient = url.searchParams.get("recipient");
      return Response.json(received.filter((entry) => recipientsOf(entry).includes(recipient)));
    }
    if (request.method !== "POST" || url.pathname !== "/emails") {
      return new Response(null, { status: 404 });
    }
    const entry = {
      url: url.href,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    };
    received.push(entry);
    const key = entry.headers["idempotency-key"];
    const first = received.filter((other) => other.headers["idempotency-key"] === key).length === 1;
    const [, mode, status] = /^(once|always)-([0-9]{3})@/u.exec(recipientsOf(entry)[0] ?? "") ?? [];
    if (mode === "always" || (mode === "once" && first)) {
      const code = Number(status);
      const name = names[code] ?? "application_error";
      const message = "Resend message that Rondyr must not store";
      return Response.json({ statusCode: code, name, message }, { status: code });
    }
    return Response.json({ id: crypto.randomUUID() });
  },
};
`;

// The AI binding of the test Worker: workerd's AI API in front of the Workers AI
// fixture above, so that Ai.run receives its AbortSignal.
export const workersAiBinding = {
  name: "AI",
  type: "rondyr-ai-fixture",
  plugin: {
    name: "rondyr-ai-fixture",
    package: fileURLToPath(new URL("./workers-ai-binding-fixture.mjs", import.meta.url)),
  },
  options: {},
};

export function externalWorkers(compatibilityDate: string) {
  return [
    {
      name: "workers-ai-fixture",
      modules: true,
      script: workersAiFixture,
      compatibilityDate,
    },
    {
      name: "webhook-receiver-fixture",
      modules: true,
      script: webhookReceiverFixture,
      compatibilityDate,
      serviceBindings: { RESEND: "resend-fixture", SITEVERIFY: "siteverify-fixture" },
    },
    {
      name: "resend-fixture",
      modules: true,
      script: resendFixture,
      compatibilityDate,
    },
    {
      name: "siteverify-fixture",
      modules: true,
      script: siteverifyFixture,
      compatibilityDate,
    },
  ];
}
