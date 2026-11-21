import { z } from "astro/zod";

import type { FlatFields } from "./fields.ts";

/** `fetch`, or the EmDash plugin's `ctx.http.fetch` limited to the Rondyr host. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const SubmissionStatus = z.enum([
  "received",
  "classifying",
  "accepted",
  "quarantined",
  "archived",
]);
export type SubmissionStatus = z.infer<typeof SubmissionStatus>;

const Fields = z.record(z.string(), z.string());

const Row = z.object({
  submissionId: z.string(),
  formPublicId: z.string(),
  formName: z.string(),
  receivedAt: z.number().int(),
  status: SubmissionStatus,
  reason: z.string().nullable(),
  label: z.string().nullable(),
});

export const InboxEntry = Row.extend({ preview: Fields });
export type InboxEntry = z.infer<typeof InboxEntry>;

export const InboxPage = z.object({ entries: z.array(InboxEntry), cursor: z.string().nullable() });
export type InboxPage = z.infer<typeof InboxPage>;

export const SubmissionDetail = Row.extend({ fields: Fields });
export type SubmissionDetail = z.infer<typeof SubmissionDetail>;

const StatusCounts = z.object({
  received: z.number().int(),
  classifying: z.number().int(),
  accepted: z.number().int(),
  quarantined: z.number().int(),
  archived: z.number().int(),
});

export const Counts = StatusCounts.extend({
  forms: z.array(z.object({ publicId: z.string(), counts: StatusCounts })),
});
export type Counts = z.infer<typeof Counts>;

export const RondyrForm = z.object({ publicId: z.string(), name: z.string(), status: z.string() });
export type RondyrForm = z.infer<typeof RondyrForm>;

export const Organization = z.object({
  id: z.string(),
  name: z.string(),
  forms: z.array(RondyrForm),
});
export type Organization = z.infer<typeof Organization>;

const Organizations = z.array(Organization);

/**
 * Why a call to Rondyr did not succeed. `unreachable` is a network error, a
 * timeout or a `5xx`; `unauthorized` is a token Rondyr refuses.
 */
export type RondyrFailure =
  | "unreachable"
  | "unauthorized"
  | "not-found"
  | "conflict"
  | "unexpected";

export class RondyrError extends Error {
  readonly failure: RondyrFailure;

  constructor(failure: RondyrFailure) {
    super(`Rondyr request failed: ${failure}`);
    this.name = "RondyrError";
    this.failure = failure;
  }
}

const timeoutMs = 30_000;

function failureOf(status: number): RondyrFailure {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status >= 500 || status === 429) return "unreachable";
  return "unexpected";
}

export type SubmitResult =
  | { readonly status: number }
  | { readonly status: null; readonly reason: string };

/** A Rondyr folder: the status its messages have. */
export type Decision = "approve" | "dismiss";

/**
 * The Rondyr API, with an API token of one organization. Every call sends the
 * token as a Bearer credential and gives up after 30 seconds.
 */
export class RondyrClient {
  readonly #fetch: Fetch;
  readonly #origin: string;
  readonly #token: string;

  constructor(fetch: Fetch, origin: string, token: string) {
    this.#fetch = fetch;
    this.#origin = origin;
    this.#token = token;
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.#token}`);
    try {
      return await this.#fetch(new URL(path, this.#origin).href, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new RondyrError("unreachable");
    }
  }

  async #json<T>(path: string, schema: z.ZodType<T>, method = "GET"): Promise<T> {
    const response = await this.#request(path, { method });
    if (!response.ok) throw new RondyrError(failureOf(response.status));
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new RondyrError("unexpected");
    return parsed.data;
  }

  /**
   * Send a submission as a server intake. Returns the HTTP status, or the reason
   * Rondyr was not reached: a network error, a timeout, or a host that the
   * platform refuses. The reason never contains the fields.
   */
  async submit(
    publicId: string,
    fields: FlatFields,
    idempotencyKey: string,
  ): Promise<SubmitResult> {
    const headers = new Headers({
      authorization: `Bearer ${this.#token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    });
    try {
      const response = await this.#fetch(
        new URL(`/f/${encodeURIComponent(publicId)}`, this.#origin).href,
        {
          method: "POST",
          headers,
          body: JSON.stringify(fields),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      await response.body?.cancel();
      return { status: response.status };
    } catch (error) {
      return { status: null, reason: error instanceof Error ? error.message : "Request failed" };
    }
  }

  /** The token's organization and its forms. */
  async organization(): Promise<Organization> {
    const [organization] = await this.#json("/api/organizations", Organizations);
    if (organization === undefined) throw new RondyrError("unauthorized");
    return organization;
  }

  async list(
    organizationId: string,
    status: SubmissionStatus,
    form: string | null,
    after: string | null,
  ): Promise<InboxPage> {
    const query = new URLSearchParams({ status });
    if (form !== null) query.set("form", form);
    if (after !== null) query.set("after", after);
    return this.#json(`${this.#base(organizationId)}/submissions?${query}`, InboxPage);
  }

  async counts(organizationId: string): Promise<Counts> {
    return this.#json(`${this.#base(organizationId)}/submission-counts`, Counts);
  }

  async detail(organizationId: string, submissionId: string): Promise<SubmissionDetail> {
    const path = `${this.#base(organizationId)}/submissions/${encodeURIComponent(submissionId)}`;
    return this.#json(path, SubmissionDetail);
  }

  async decide(
    organizationId: string,
    submissionId: string,
    decision: Decision,
  ): Promise<SubmissionDetail> {
    const path = `${this.#base(organizationId)}/submissions/${encodeURIComponent(submissionId)}/${decision}`;
    return this.#json(path, SubmissionDetail, "POST");
  }

  #base(organizationId: string) {
    return `/api/organizations/${encodeURIComponent(organizationId)}`;
  }
}
