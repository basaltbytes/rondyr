import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Schema } from "effect";

import { SubmissionDetail } from "../src/domain/submissions/inbox.ts";
import { SubmissionId } from "../src/domain/submissions/submission.id.ts";

class SmokeError extends Error {}

const decodeSubmission = Schema.decodeUnknownSync(Schema.Struct({ "submission-id": SubmissionId }));
const decodeDetail = Schema.decodeUnknownSync(SubmissionDetail);

function setting(name) {
  const value = process.env[name];
  if (!value) throw new SmokeError(`Set ${name} for the staging smoke test.`);
  return value;
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
  const organizationId = encodeURIComponent(setting("RONDYR_SMOKE_ORGANIZATION_ID_STAGING"));
  const formId = encodeURIComponent(setting("RONDYR_SMOKE_FORM_ID_STAGING"));
  const email = setting("RONDYR_SMOKE_EMAIL_STAGING");
  const password = setting("RONDYR_SMOKE_PASSWORD_STAGING");

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

  const health = await request("/health", 200);
  if ((await health.json()).status !== "ok")
    throw new SmokeError("Staging health did not report ok.");

  const json = { "content-type": "application/json", origin: origin.origin };
  const session = await request("/api/auth/sign-in/email", 200, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email, password }),
  });
  const cookie = session.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  if (!cookie) throw new SmokeError("Staging sign-in returned no session cookie.");

  const message = `Hello, is there a place available in your pottery workshop on Saturday? Reference ${randomUUID()}.`;
  const submission = await request(`/f/${formId}`, 202, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Staging smoke test", message }),
  });
  const { "submission-id": submissionId } = decodeSubmission(await submission.json());

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const detail = await request(
      `/api/organizations/${organizationId}/submissions/${submissionId}`,
      200,
      {
        headers: { cookie },
      },
    );
    const entry = decodeDetail(await detail.json());
    if (entry.submissionId !== submissionId || entry.fields.message !== message) {
      throw new SmokeError("Staging returned the wrong submission.");
    }
    if (entry.reason === "classification-error" || entry.reason === "honeypot") {
      throw new SmokeError(`Staging did not classify the smoke submission (${entry.reason}).`);
    }
    if (entry.status === "accepted" || entry.status === "quarantined") return;
    await setTimeout(3_000);
  }
  throw new SmokeError("Staging did not classify the smoke submission within three minutes.");
}

try {
  await smoke();
  process.stdout.write("Staging health and submission processing passed.\n");
} catch (error) {
  // Fetch and JSON errors can include remote responses. Print only messages defined above.
  const message =
    error instanceof SmokeError ? error.message : "Staging request or response failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
