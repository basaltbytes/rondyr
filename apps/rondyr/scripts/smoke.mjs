// Check a deployment: its /health, then, with a form and an API token, that one
// synthetic submission gets classified. See docs/operations.md#smoke-test.
//
//   pnpm smoke <origin> [--form <public ID>] [--health-timeout <seconds>]
//
// The API token comes from RONDYR_SMOKE_API_TOKEN, never from the command line.
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Schema } from "effect";

import { IntakeReason } from "../src/domain/submissions/classification.ts";
import { InboxOrganizationWithForms } from "../src/domain/submissions/inbox-setup.ts";
import { SubmissionDetail } from "../src/domain/submissions/inbox.ts";
import { SubmissionId } from "../src/domain/submissions/submission.id.ts";

class SmokeError extends Error {}

const decodeSubmission = Schema.decodeUnknownSync(Schema.Struct({ "submission-id": SubmissionId }));
const decodeDetail = Schema.decodeUnknownSync(SubmissionDetail);
const decodeOrganizations = Schema.decodeUnknownSync(Schema.Array(InboxOrganizationWithForms));
const isIntakeReason = Schema.is(IntakeReason);

const usage = "Usage: pnpm smoke <origin> [--form <public ID>] [--health-timeout <seconds>]";
const healthRetryMs = 10_000;
const classificationTimeoutMs = 180_000;

/** One line about a failure: a message defined here, never a remote response. */
function describe(error) {
  return error instanceof SmokeError ? error.message : "The request or its response failed.";
}

/** The origin, the optional submission check, and how long /health may take to answer. */
function settings() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { form: { type: "string" }, "health-timeout": { type: "string" } },
    });
  } catch {
    throw new SmokeError(usage);
  }
  const { positionals, values } = parsed;
  if (positionals.length !== 1) throw new SmokeError(usage);

  let origin;
  try {
    origin = new URL(positionals[0]);
  } catch {
    throw new SmokeError("The origin is not a URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  const httpsOrigin = origin.protocol === "https:" && origin.port === "";
  if (
    !(httpsOrigin || (local && origin.protocol === "http:")) ||
    origin.href !== `${origin.origin}/`
  ) {
    throw new SmokeError(
      "The origin must be an HTTPS origin without a path or a port, such as https://forms.example.com.",
    );
  }

  const timeout = Number(values["health-timeout"] ?? "180");
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 3_600) {
    throw new SmokeError("--health-timeout takes a number of seconds from 0 to 3600.");
  }

  const token = process.env.RONDYR_SMOKE_API_TOKEN;
  const formId = values.form;
  if (formId === undefined && token) {
    throw new SmokeError("RONDYR_SMOKE_API_TOKEN is set: pass --form with the test form's ID.");
  }
  if (formId !== undefined && !token) {
    throw new SmokeError(
      "--form needs the API token of the form's organization in RONDYR_SMOKE_API_TOKEN.",
    );
  }
  return {
    origin,
    healthTimeoutMs: timeout * 1_000,
    submission: formId === undefined ? null : { formId, token },
  };
}

async function smoke({ origin, healthTimeoutMs, submission }) {
  async function request(path, status, init) {
    const response = await fetch(new URL(path, origin), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== status) {
      throw new SmokeError(
        `The deployment returned HTTP ${response.status}; expected ${status} for ${path.split("/").slice(0, 3).join("/")}.`,
      );
    }
    return response;
  }

  // A new version takes a few seconds to serve every request. The first deployment on a
  // workers.dev route or on a new custom domain can take minutes, until the route, the
  // DNS record and the certificate are ready. Each failed try prints one line.
  const healthDeadline = Date.now() + healthTimeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const health = await request("/health", 200);
      const body = await health.json().catch(() => null);
      if (body?.status !== "ok") throw new SmokeError("/health did not report ok.");
      break;
    } catch (error) {
      if (Date.now() + healthRetryMs > healthDeadline) throw error;
      process.stderr.write(`Health check ${attempt} failed: ${describe(error)} Trying again.\n`);
      await setTimeout(healthRetryMs);
    }
  }
  if (submission === null) return "health";

  const authorization = { authorization: `Bearer ${submission.token}` };
  const organizations = await request("/api/organizations", 200, { headers: authorization });
  const [organization] = decodeOrganizations(await organizations.json());
  if (organization?.forms.some(({ publicId }) => publicId === submission.formId) !== true) {
    throw new SmokeError("The form does not belong to the API token's organization.");
  }

  const message = `Hello, is there a place available in your pottery workshop on Saturday? Reference ${randomUUID()}.`;
  const accepted = await request(`/f/${encodeURIComponent(submission.formId)}`, 202, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Rondyr smoke test", message }),
  });
  const { "submission-id": submissionId } = decodeSubmission(await accepted.json());

  const detailPath = `/api/organizations/${encodeURIComponent(organization.id)}/submissions/${submissionId}`;
  const deadline = Date.now() + classificationTimeoutMs;
  while (Date.now() < deadline) {
    const detail = await request(detailPath, 200, { headers: authorization });
    const entry = decodeDetail(await detail.json());
    if (entry.submissionId !== submissionId || entry.fields.message !== message) {
      throw new SmokeError("The deployment returned the wrong submission.");
    }
    // A classifier error, or a quarantine at intake, means the classifier did not answer.
    if (entry.reason === "classification-error" || isIntakeReason(entry.reason)) {
      throw new SmokeError(`The smoke submission was not classified (${entry.reason}).`);
    }
    if (entry.status === "accepted" || entry.status === "quarantined") return "submission";
    await setTimeout(3_000);
  }
  throw new SmokeError("The smoke submission was not classified within three minutes.");
}

try {
  const checked = await smoke(settings());
  process.stdout.write(
    checked === "health"
      ? "Health check passed. Pass --form and RONDYR_SMOKE_API_TOKEN to check a submission too.\n"
      : "Health check and submission classification passed.\n",
  );
} catch (error) {
  // Fetch and JSON errors can include remote responses. Print only messages defined above.
  process.stderr.write(`${describe(error)}\n`);
  process.exitCode = 1;
}
