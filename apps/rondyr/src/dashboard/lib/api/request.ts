import { Option, Schema } from "effect";

/**
 * A request that the API answered with an error status. `refusal` is the body in which
 * the API explains why, decoded by the schema of the client that sent the request, when
 * the API sends one that the schema reads.
 */
export class RequestFailed extends Schema.TaggedError<
  RequestFailed,
  { readonly brand: unique symbol }
>()("RequestFailed", {
  status: Schema.Int,
  refusal: Schema.Option(Schema.Unknown),
}) {}

export const isRequestFailed = Schema.is(RequestFailed);

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOptions {
  readonly method?: Method;
  /** Sent as JSON. */
  readonly json?: object;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | undefined;
  readonly cache?: RequestCache;
  /** The schema of the body that explains a refusal, for a route whose refusals have one. */
  readonly refusal?: Schema.Decoder<unknown>;
}

function initOf({ method, json, headers, signal, cache }: RequestOptions): RequestInit {
  const init: RequestInit = { method: method ?? "GET" };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers = { "content-type": "application/json", ...headers };
  } else if (headers !== undefined) {
    init.headers = headers;
  }
  if (signal !== undefined) init.signal = signal;
  if (cache !== undefined) init.cache = cache;
  return init;
}

/**
 * Sends a request to the Rondyr API and returns its answer. An answer with an error
 * status throws `RequestFailed`. `fetch` throws a `TypeError` when the server cannot
 * be reached.
 */
export async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const response = await fetch(path, initOf(options));
  if (response.ok) return response;
  const { refusal } = options;
  const body: unknown =
    refusal === undefined ? null : await response.json().catch((): null => null);
  throw RequestFailed.make({
    status: response.status,
    refusal: refusal === undefined ? Option.none() : Schema.decodeUnknownOption(refusal)(body),
  });
}

/** Sends a request, then decodes its answer with `schema`. */
export async function requestJson<S extends Schema.Decoder<unknown>>(
  path: string,
  schema: S,
  options: RequestOptions = {},
): Promise<S["Type"]> {
  const response = await request(path, options);
  return Schema.decodeUnknownPromise(schema)(await response.json());
}

/** The status of a refused request, or null for another failure. */
export function statusOf(cause: unknown): number | null {
  return isRequestFailed(cause) ? cause.status : null;
}

/** The refusal that a request failed with, when the client decoded it with `schema`. */
export function refusalOf<S extends Schema.Decoder<unknown>>(
  cause: unknown,
  schema: S,
): Option.Option<S["Type"]> {
  return isRequestFailed(cause) ? Option.filter(cause.refusal, Schema.is(schema)) : Option.none();
}

/**
 * Why a read failed: the server did not answer, it answered with an error status, or its
 * answer is not one that this version of the dashboard reads.
 */
export type ReadFailure = "unreachable" | "unreadable" | { readonly status: number };

export function readFailureOf(cause: unknown): ReadFailure {
  if (isRequestFailed(cause)) return { status: cause.status };
  // `fetch` rejects with a TypeError when the server cannot be reached.
  return cause instanceof TypeError ? "unreachable" : "unreadable";
}

/** The path of a resource of an organization in the API. */
export function organizationPath(organizationId: string, ...segments: ReadonlyArray<string>) {
  return [
    `/api/organizations/${encodeURIComponent(organizationId)}`,
    ...segments.map(encodeURIComponent),
  ].join("/");
}
