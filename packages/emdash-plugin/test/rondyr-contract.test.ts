// `cloudflare:workers` is typed by the root's generated worker-configuration.d.ts,
// which pulls in the Worker's sources; `cloudflare:test` gives the same bindings.
import { applyD1Migrations, env } from "cloudflare:test";
import { z } from "astro/zod";
import { beforeAll, expect, it, vi } from "vitest";

import { testOrigin, testSetupToken } from "../../../tests/integration/auth-fixture.ts";
import { flattenFields, type FormLayout } from "../src/core/fields.ts";
import { newEntry, QueueEntry } from "../src/core/queue.ts";
import { RondyrClient } from "../src/core/rondyr-client.ts";
import { verifyWebhook } from "../src/core/signature.ts";
import { attempt, sendDue } from "../src/delivery.ts";
import { Store } from "../src/store.ts";
import { memoryHost } from "../src/testing/memory-storage.ts";
import { receiveWebhook } from "../src/webhook.ts";

// The plugin's own code against the built Rondyr Worker, in workerd: intake with a
// token and an idempotency key, the folders and counts, a decision, then the
// webhook that Rondyr signs, checked by the plugin's verification.

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const worker = (url: string, init?: RequestInit) => env.TEST_WORKER.fetch(url, init);

async function api(method: string, path: string, body: string | null, headers: HeadersInit) {
  const request = new Headers(headers);
  request.set("origin", testOrigin);
  if (body !== null) request.set("content-type", "application/json");
  return worker(new URL(path, testOrigin).href, { method, headers: request, body });
}

const Session = z.object({
  id: z.string(),
  name: z.string(),
  forms: z.array(z.object({ publicId: z.string() })),
});
const Created = z.object({ token: z.string() });
const Issued = z.object({ secret: z.string() });
const Received = z.array(
  z.object({ headers: z.record(z.string(), z.string()), body: z.string(), path: z.string() }),
);
const Delivered = z.object({
  type: z.literal("submission.accepted"),
  submission: z.object({ id: z.string(), fields: z.record(z.string(), z.string()) }),
  form: z.object({ id: z.string() }),
});

const owner = {
  name: "Contract owner",
  email: "contract@example.test",
  password: "contract-test-password",
};
let ownerCreated = false;

async function siteOrganization(organizationName = "EmDash site") {
  if (!ownerCreated) {
    const setup = await api("POST", "/api/setup", JSON.stringify(owner), {
      authorization: `Bearer ${testSetupToken}`,
    });
    expect(setup.status).toBe(201);
    ownerCreated = true;
  }
  const credentials = JSON.stringify({ email: owner.email, password: owner.password });
  const signedIn = await api("POST", "/api/auth/sign-in/email", credentials, {});
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value: string) => value.split(";", 1)[0])
    .join("; ");
  const inbox = JSON.stringify({
    organizationName,
    formName: "Contact",
    businessContext: "",
  });
  expect((await api("POST", "/api/organizations", inbox, { cookie })).status).toBe(201);
  const listed = await api("GET", "/api/organizations", null, { cookie });
  const organization = z
    .array(Session)
    .parse(await listed.json())
    .find(({ name }) => name === organizationName);
  const form = organization?.forms[0];
  if (organization === undefined || form === undefined) throw new Error("Expected a form");
  const tokens = `/api/organizations/${organization.id}/api-tokens`;
  const created = await api("POST", tokens, JSON.stringify({ name: "EmDash site" }), { cookie });
  const { token } = Created.parse(await created.json());
  return { cookie, organizationId: organization.id, publicId: form.publicId, token };
}

const layout: FormLayout = {
  slug: "contact",
  name: "Contact",
  fields: [
    { name: "name", label: "Name", type: "text" },
    { name: "email", label: "Email", type: "email" },
    { name: "topics", label: "Topics", type: "checkbox-group" },
    { name: "message", label: "Message", type: "textarea" },
    { name: "cv", label: "CV", type: "file" },
  ],
};

it("sends, reads, decides and verifies the webhook with the plugin's code", async () => {
  const { cookie, organizationId, publicId, token } = await siteOrganization();
  const prefix = `/emdash-contract-${crypto.randomUUID()}`;
  const target = await api(
    "POST",
    `/api/organizations/${organizationId}/forms/${publicId}/targets`,
    JSON.stringify({ type: "webhook", url: `https://site.example.com${prefix}/ok` }),
    { cookie },
  );
  expect(target.status).toBe(201);
  const { secret } = Issued.parse(await target.json());
  const honeypot = await api(
    "PUT",
    `/api/organizations/${organizationId}/forms/${publicId}/honeypot`,
    JSON.stringify({ field: "_hp" }),
    { cookie },
  );
  expect(honeypot.status).toBe(200);

  const client = new RondyrClient(worker, testOrigin, token);
  const fields = {
    ...flattenFields(layout, {
      name: "Ada",
      email: "ada@example.com",
      topics: ["Pottery", "Glazing"],
      message: "Is there room in the class?",
      cv: "cv.pdf",
    }),
    // The form's honeypot field, filled: Rondyr quarantines the message at intake.
    _hp: "filled",
  };
  const key = crypto.randomUUID();
  expect(await client.submit(publicId, fields, key)).toEqual({ status: 202 });
  // The retry after a timeout: same key, nothing new stored.
  expect(await client.submit(publicId, fields, key)).toEqual({ status: 202 });
  const stored = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM submissions s JOIN forms f ON f.id = s.form_id WHERE f.public_id = ?",
  )
    .bind(publicId)
    .first("count");
  expect(stored).toBe(1);

  const organization = await client.organization();
  expect(organization.id).toBe(organizationId);
  const page = await vi.waitFor(
    async () => {
      const next = await client.list(organizationId, "quarantined", publicId, null);
      expect(next.entries).toHaveLength(1);
      return next;
    },
    { timeout: 15_000, interval: 100 },
  );
  const [entry] = page.entries;
  if (entry === undefined) throw new Error("Expected an entry");
  expect(entry.reason).toBe("honeypot");
  const counts = await client.counts(organizationId);
  expect(counts.quarantined).toBe(1);
  expect(counts.forms).toEqual([{ publicId, counts: expect.objectContaining({ quarantined: 1 }) }]);
  const detail = await client.detail(organizationId, entry.submissionId);
  expect(detail.fields).toEqual(fields);

  const accepted = await client.decide(organizationId, entry.submissionId, "approve");
  expect(accepted.status).toBe("accepted");
  await expect(client.decide(organizationId, entry.submissionId, "dismiss")).rejects.toMatchObject({
    failure: "conflict",
  });
  expect((await client.list(organizationId, "accepted", null, null)).entries).toHaveLength(1);

  const request = await vi.waitFor(
    async () => {
      const response = await env.WEBHOOK_RECEIVER.fetch(
        `https://receiver.test/__received?prefix=${encodeURIComponent(`${prefix}/`)}`,
      );
      const [first, ...others] = Received.parse(await response.json());
      expect(others).toEqual([]);
      if (first === undefined) throw new Error("The webhook has not arrived yet");
      return first;
    },
    { timeout: 30_000, interval: 200 },
  );
  const body = new TextEncoder().encode(request.body);
  const headers = new Headers(request.headers);
  expect(await verifyWebhook(body, headers, secret, Date.now())).toBe("valid");
  expect(await verifyWebhook(body, headers, "whsec_another-secret", Date.now())).toBe(
    "invalid-signature",
  );
  expect(await verifyWebhook(body, headers, secret, Date.now() + 301_000)).toBe("stale-timestamp");
  const tampered = new TextEncoder().encode(request.body.replace("Ada", "Eve"));
  expect(await verifyWebhook(tampered, headers, secret, Date.now())).toBe("invalid-signature");
  expect(Delivered.parse(JSON.parse(request.body))).toEqual({
    type: "submission.accepted",
    submission: { id: entry.submissionId, fields },
    form: { id: publicId },
  });

  // The plugin's webhook route on the request Rondyr sent: one email per recipient, once.
  const { host, lines } = memoryHost();
  const store = new Store(host);
  await store.putLink("contact", { rondyrFormId: publicId, recipients: ["team@example.com"] });
  await store.putLayout(layout);
  const sent: { to: string; subject: string; text: string; replyTo?: string }[] = [];
  const email = { send: async (message: (typeof sent)[number]) => void sent.push(message) };
  const site = { ...host, email, input: body, request: { headers } };
  expect(await receiveWebhook(site, [secret], Date.now())).toEqual({ status: 200, emailed: 1 });
  expect(await receiveWebhook(site, [secret], Date.now())).toEqual({ status: 200, emailed: 0 });
  expect(sent).toEqual([
    {
      to: "team@example.com",
      subject: "New submission: Contact",
      replyTo: "ada@example.com",
      text: expect.stringContaining(
        "Topics: Pottery, Glazing\nMessage: Is there room in the class?",
      ),
    },
  ]);
  expect(lines).toEqual([]);
});

it("stores a submission once when the first attempt times out after Rondyr stored it", async () => {
  const { organizationId, publicId, token } = await siteOrganization("Timeout site");
  const { host } = memoryHost();
  const store = new Store(host);
  await store.putLink("contact", { rondyrFormId: publicId, recipients: [] });
  const id = crypto.randomUUID();
  await store.createQueueEntry(id, newEntry("contact", { message: "Sent during a timeout" }, 0));
  let calls = 0;
  const http = {
    fetch: async (url: string, init?: RequestInit) => {
      calls += 1;
      const response = await worker(url, init);
      // The first answer never reaches the site, as after a timeout.
      if (calls === 1) throw new Error("The request timed out");
      return response;
    },
  };
  const options = { url: testOrigin };
  expect(await attempt({ ...host, http }, options, token, id, () => 0)).toBe("retry");
  const retry = await store.queueEntry(id);
  expect(retry).toMatchObject({ state: "pending", attempts: 1, lastStatus: null });
  expect(await attempt({ ...host, http }, options, token, id, () => 60_000)).toBe("sent");
  expect(await store.queueEntry(id)).toBeNull();
  const client = new RondyrClient(worker, testOrigin, token);
  const counts = await client.counts(organizationId);
  const total =
    counts.received + counts.classifying + counts.accepted + counts.quarantined + counts.archived;
  expect(total).toBe(1);
});

it("loses and duplicates nothing when Rondyr is unreachable for an hour", async () => {
  const { organizationId, publicId, token } = await siteOrganization("Outage site");
  const { host, collections } = memoryHost();
  const store = new Store(host);
  await store.putLink("contact", { rondyrFormId: publicId, recipients: [] });
  const start = Date.UTC(2026, 10, 21, 9);
  const clock = { now: start };
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
  for (const [index, id] of ids.entries()) {
    const fields = { email: `visitor-${index}@example.com`, message: `Message ${index}` };
    await store.createQueueEntry(id, newEntry("contact", fields, start));
  }
  const outageEnds = start + 3_600_000;
  const keys: string[] = [];
  let lostAnswer = false;
  const http = {
    fetch: async (url: string, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (clock.now < outageEnds) throw new TypeError("Network connection lost");
      const response = await worker(url, init);
      // The first answer after the outage is lost after Rondyr stored the message.
      if (!lostAnswer) {
        lostAnswer = true;
        throw new DOMException("The operation timed out", "TimeoutError");
      }
      return response;
    },
  };
  const options = { url: testOrigin };
  // The attempts right after each visitor's response, during the outage.
  for (const id of ids) await attempt({ ...host, http }, options, token, id, () => clock.now);
  // Then the cron, once a minute, until the queue is empty.
  for (let run = 0; run < 1_000 && collections.queue.rows.size > 0; run += 1) {
    const due = [...collections.queue.rows.values()].map(
      ({ data }) => QueueEntry.parse(data).nextAttemptAt,
    );
    const next = Math.max(clock.now + 60_000, Math.min(...due));
    clock.now = Math.ceil(next / 60_000) * 60_000;
    await sendDue({ ...host, http }, options, token, () => clock.now);
  }
  expect(collections.queue.rows.size).toBe(0);
  expect(clock.now).toBeGreaterThan(outageEnds);
  // Every attempt for a message used its own key, and one key was sent again after the lost answer.
  expect(new Set(keys)).toEqual(new Set(ids));
  const client = new RondyrClient(worker, testOrigin, token);
  const counts = await client.counts(organizationId);
  const total =
    counts.received + counts.classifying + counts.accepted + counts.quarantined + counts.archived;
  expect(total).toBe(3);
});
