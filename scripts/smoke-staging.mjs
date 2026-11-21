import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Schema } from "effect";

import { InboxOrganizationWithForms } from "../src/domain/submissions/inbox-setup.ts";
import { SubmissionDetail } from "../src/domain/submissions/inbox.ts";
import { SubmissionId } from "../src/domain/submissions/submission.id.ts";

class SmokeError extends Error {}

const decodeSubmission = Schema.decodeUnknownSync(Schema.Struct({ "submission-id": SubmissionId }));
const decodeDetail = Schema.decodeUnknownSync(SubmissionDetail);
const decodeOrganizations = Schema.decodeUnknownSync(Schema.Array(InboxOrganizationWithForms));

function setting(name) {
  const value = process.env[name];
  if (!value) throw new SmokeError(`Set ${name} for the staging smoke test.`);
  return value;
}

/** The form and token of the submission check, or null when neither is set. */
function submissionSettings() {
  const formId = process.env.RONDYR_SMOKE_FORM_ID_STAGING;
  const token = process.env.RONDYR_SMOKE_API_TOKEN_STAGING;
  if (!formId && !token) return null;
  return {
    formId: setting("RONDYR_SMOKE_FORM_ID_STAGING"),
    token: setting("RONDYR_SMOKE_API_TOKEN_STAGING"),
  };
}

async function smoke() {
  const origin = new URL(setting("BETTER_AUTH_URL_STAGING"));
  if (
    origin.protocol !== "https:" ||
    origin.href !== `${origin.origin}/` ||
    origin.port !== "" ||
    !/^rondyr-staging\.[a-z0-9-]+\.workers\.dev$/u.test(origin.hostname)
  ) {
    throw new SmokeError("The smoke test requires the rondyr-staging workers.dev origin.");
  }
  const settings = submissionSettings();

  async function request(path, status, init) {
    const response = await fetch(new URL(path, origin), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== status) {
      throw new SmokeError(
        `Staging returned HTTP ${response.status}; expected ${status} for ${path.split("/").slice(0, 3).join("/")}.`,
      );
    }
    return response;
  }

  // A new version can take a few seconds to serve every request.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const health = await request("/health", 200);
      if ((await health.json()).status !== "ok") {
        throw new SmokeError("Staging health did not report ok.");
      }
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await setTimeout(5_000);
    }
  }
  if (settings === null) return "health";

  const authorization = { authorization: `Bearer ${settings.token}` };
  const organizations = await request("/api/organizations", 200, { headers: authorization });
  const [organization] = decodeOrganizations(await organizations.json());
  if (organization?.forms.some(({ publicId }) => publicId === settings.formId) !== true) {
    throw new SmokeError("The smoke form does not belong to the API token's organization.");
  }

  const message = `Hello, is there a place available in your pottery workshop on Saturday? Reference ${randomUUID()}.`;
  const submission = await request(`/f/${encodeURIComponent(settings.formId)}`, 202, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Staging smoke test", message }),
  });
  const { "submission-id": submissionId } = decodeSubmission(await submission.json());

  const detailPath = `/api/organizations/${encodeURIComponent(organization.id)}/submissions/${submissionId}`;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const detail = await request(detailPath, 200, { headers: authorization });
    const entry = decodeDetail(await detail.json());
    if (entry.submissionId !== submissionId || entry.fields.message !== message) {
      throw new SmokeError("Staging returned the wrong submission.");
    }
    if (entry.reason === "classification-error" || entry.reason === "honeypot") {
      throw new SmokeError(`Staging did not classify the smoke submission (${entry.reason}).`);
    }
    if (entry.status === "accepted" || entry.status === "quarantined") return "submission";
    await setTimeout(3_000);
  }
  throw new SmokeError("Staging did not classify the smoke submission within three minutes.");
}

try {
  const checked = await smoke();
  process.stdout.write(
    checked === "health"
      ? "Staging health passed. The submission check is not configured.\n"
      : "Staging health and submission processing passed.\n",
  );
} catch (error) {
  // Fetch and JSON errors can include remote responses. Print only messages defined above.
  const message =
    error instanceof SmokeError ? error.message : "Staging request or response failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
