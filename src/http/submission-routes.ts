import { ByteSize, Effect, Layer, Match, Option, Result, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  MultipartParser,
} from "effect/http";

import { TurnstileToken, turnstileField } from "../domain/forms/turnstile.ts";
import {
  confirmationLanguage,
  confirmationPages,
} from "../domain/submissions/confirmation-page.ts";
import { joinRepeatedFields, SubmittedFields } from "../domain/submissions/submission-fields.ts";
import { SubmissionId } from "../domain/submissions/submission.id.ts";
import { publishSubmission } from "../jobs/submission-outbox.ts";
import { BackgroundTasks } from "../ports/background-tasks.ts";
import { ClientRateLimit } from "../ports/client-rate-limit.ts";
import {
  SubmissionIntake,
  type EmptySubmission,
  type FormNotFound,
  type FormRateLimited,
  type FormSuspended,
  type OriginMatch,
  type OriginRefused,
  type OrganizationRateLimited,
} from "../ports/intake.ts";
import type { StorageUnavailable } from "../ports/storage.ts";

const PublicFormPath = Schema.Struct({
  formId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
const Accepted = Schema.Struct({
  "submission-id": SubmissionId,
  status: Schema.Literal("received"),
});
const accepted = HttpServerResponse.schemaJson(Accepted);
const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const decodeFields = Schema.decodeUnknownEffect(SubmittedFields);
const decodeToken = Schema.decodeUnknownOption(TurnstileToken);

const splitFields = Effect.fnUntraced(function* (fields: Readonly<Record<string, string>>) {
  const { [turnstileField]: value, ...message } = fields;
  return { fields: yield* decodeFields(message), token: decodeToken(value) };
});

// Browsers cache a preflight for at most this long; Chromium caps it at 2 hours.
const preflightMaxAgeSeconds = "7200";

type Headers = Readonly<Record<string, string>>;

type CorsHeaders = {
  readonly "access-control-allow-origin"?: string;
  readonly vary?: "Origin";
};

/**
 * The CORS headers of a response. No response allows credentials. A form
 * without allowed origins, an unknown form, and an unavailable database get
 * `*`: none of their responses depends on the request's origin.
 */
function corsHeaders(origins: OriginMatch, origin: Option.Option<string>): CorsHeaders {
  if (origins === "unrestricted") return { "access-control-allow-origin": "*" };
  return Option.match(origin, {
    onSome: (value) =>
      origins === "listed"
        ? { "access-control-allow-origin": value, vary: "Origin" }
        : { vary: "Origin" },
    onNone: () => ({ vary: "Origin" }),
  });
}

function empty(status: number, headers: Headers) {
  return HttpServerResponse.empty({ status, headers: { "cache-control": "no-store", ...headers } });
}

/**
 * The text fields of a `multipart/form-data` body, in order. A part with a
 * `filename` parameter is a file, even an empty one from a file input left
 * blank, and Rondyr stores no file: the body is refused.
 */
const readMultipart = Effect.fnUntraced(function* (body: ArrayBuffer, contentType: string) {
  const entries: Array<readonly [string, string]> = [];
  let refused = false;
  const parser = MultipartParser.make({
    headers: { "content-type": contentType },
    isFile: (part) => part.filename !== undefined,
    onField: (part, value) => entries.push([part.name, MultipartParser.decodeField(part, value)]),
    onFile: () => {
      refused = true;
      return () => {};
    },
    onError: () => {
      refused = true;
    },
    onDone: () => {},
  });
  // The parser runs its callbacks synchronously, so the body is parsed when `end` returns.
  parser.write(new Uint8Array(body));
  parser.end();
  if (refused) return yield* MalformedForm.make();
  return entries;
});

class MalformedForm extends Schema.TaggedError<MalformedForm, { readonly brand: unique symbol }>()(
  "MalformedForm",
  {},
) {}

/** A request refused before the form is read: 400, 413 or 415. */
class InvalidBody extends Schema.TaggedError<InvalidBody, { readonly brand: unique symbol }>()(
  "InvalidBody",
  { status: Schema.Literals([400, 413, 415]) },
) {}

/**
 * Decode the fields of a JSON, URL-encoded or multipart body. A form body may
 * repeat a field name, whose values are joined; a JSON body has string values only.
 */
const readFields = Effect.fnUntraced(
  function* (request: HttpServerRequest.HttpServerRequest) {
    const contentType = request.headers["content-type"] ?? "";
    const media = contentType.split(";", 1)[0]?.trim().toLowerCase();
    if (media === "application/json") {
      const body = yield* request.text;
      const incoming = yield* decodeJson(body);
      return { json: true, ...(yield* splitFields(incoming)) };
    }
    if (media === "application/x-www-form-urlencoded") {
      const body = yield* request.text;
      const fields = joinRepeatedFields(new URLSearchParams(body));
      return { json: false, ...(yield* splitFields(fields)) };
    }
    if (media === "multipart/form-data") {
      const body = yield* request.arrayBuffer;
      const entries = yield* readMultipart(body, contentType);
      return { json: false, ...(yield* splitFields(joinRepeatedFields(entries))) };
    }
    return yield* InvalidBody.make({ status: 415 });
  },
  Effect.catchTags({
    SchemaError: () => InvalidBody.make({ status: 400 }),
    MalformedForm: () => InvalidBody.make({ status: 400 }),
    HttpServerError: ({ reason }) =>
      InvalidBody.make({
        status: reason._tag === "RequestParseError" && reason.reason === "BodyTooLarge" ? 413 : 400,
      }),
  }),
);

/** The origin rule of the form decides the CORS headers of an invalid request, not its status. */
const refuseBody = Effect.fnUntraced(function* (
  publicId: string,
  origin: Option.Option<string>,
  status: InvalidBody["status"],
) {
  if (Option.isNone(origin)) return empty(status, {});
  const intake = yield* SubmissionIntake;
  const origins = yield* intake.matchOrigin(publicId, origin).pipe(
    Effect.catchTags({
      FormNotFound: () => Effect.succeed("unrestricted" as const),
      StorageUnavailable: () => Effect.succeed("unrestricted" as const),
    }),
  );
  return empty(status, corsHeaders(origins, origin));
});

function rateLimited(cors: CorsHeaders, retryAfter = 60) {
  return empty(429, {
    "retry-after": String(retryAfter),
    "access-control-expose-headers": "retry-after",
    ...cors,
  });
}

function refusal(
  error:
    | FormNotFound
    | FormRateLimited
    | OrganizationRateLimited
    | FormSuspended
    | OriginRefused
    | EmptySubmission
    | StorageUnavailable,
  origin: Option.Option<string>,
) {
  return Match.valueTags(error, {
    FormNotFound: () => empty(404, corsHeaders("unrestricted", origin)),
    // A page on an allowed origin can read this refusal, as it can read a 429.
    FormSuspended: ({ origins }) => empty(403, corsHeaders(origins, origin)),
    // A browser cannot read this response: it has no Access-Control-Allow-Origin.
    OriginRefused: () => empty(403, corsHeaders("unlisted", origin)),
    // The honeypot field was the only field: there is no message.
    EmptySubmission: ({ origins }) => empty(400, corsHeaders(origins, origin)),
    FormRateLimited: ({ origins }) => rateLimited(corsHeaders(origins, origin)),
    OrganizationRateLimited: ({ origins, retryAfter }) =>
      rateLimited(corsHeaders(origins, origin), retryAfter),
    StorageUnavailable: () => empty(503, corsHeaders("unrestricted", origin)),
  });
}

/**
 * Count the request against its client's limit on this form. A request without
 * `CF-Connecting-IP`, which Cloudflare sets on every request it receives, is not
 * counted: local development and tests have no client address. A limited client
 * gets the CORS headers of an invalid request: the form's list decides them, and
 * is read only for a request with an `Origin` header.
 */
const limitClient = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  publicId: string,
  origin: Option.Option<string>,
) {
  const address = request.headers["cf-connecting-ip"];
  if (address === undefined || address === "") return Option.none();
  const limit = yield* ClientRateLimit;
  if (yield* limit.admit(publicId, address)) return Option.none();
  if (Option.isNone(origin)) return Option.some(rateLimited({}));
  const intake = yield* SubmissionIntake;
  const origins = yield* intake.matchOrigin(publicId, origin).pipe(
    Effect.catchTags({
      FormNotFound: () => Effect.succeed("unrestricted" as const),
      StorageUnavailable: () => Effect.succeed("unrestricted" as const),
    }),
  );
  return Option.some(rateLimited(corsHeaders(origins, origin)));
});

// A browser sends `Origin: null` when the page hides its origin: a `no-referrer`
// policy on a form post, a sandboxed frame. Such a request is handled like one
// without the header, so a listed site that hides its origin keeps its messages.
const requestOrigin = Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
  Option.filter(Option.fromNullishOr(request.headers.origin), (origin) => origin !== "null"),
);

const receive = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const origin = yield* requestOrigin;
  const path = yield* Effect.option(HttpRouter.schemaPathParams(PublicFormPath));
  if (Option.isNone(path)) return empty(400, corsHeaders("unrestricted", origin));
  const { formId } = path.value;
  const read = yield* Effect.result(readFields(request));
  if (Result.isFailure(read)) return yield* refuseBody(formId, origin, read.failure.status);
  const { json, fields, token } = read.success;
  const limited = yield* limitClient(request, formId, origin);
  if (Option.isSome(limited)) return limited.value;
  const intake = yield* SubmissionIntake;
  const received = yield* Effect.result(intake.receive(formId, fields, origin, token));
  if (Result.isFailure(received)) return refusal(received.failure, origin);
  const { submissionId, origins, successUrl } = received.success;
  // The cron publishes the event later if this attempt fails or never runs.
  const tasks = yield* BackgroundTasks;
  yield* tasks.run(
    publishSubmission(submissionId).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Direct outbox publication failed", { submissionId, tag: error._tag }),
      ),
      Effect.ignore,
    ),
  );
  const headers = { "cache-control": "no-store", ...corsHeaders(origins, origin) };
  const browser =
    request.headers.accept
      ?.split(",")
      .some((value) => value.split(";", 1)[0]?.trim() === "text/html") ?? false;
  if (!json && browser && Option.isSome(successUrl)) {
    // The form's stored URL, never one from the request.
    return HttpServerResponse.redirect(successUrl.value, { status: 303, headers });
  }
  if (!json && browser) {
    const language = confirmationLanguage(request.headers["accept-language"]);
    const page = confirmationPages[language];
    return HttpServerResponse.text(
      `<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${page.title}</title><main><h1>${page.title}</h1><p>${page.body}</p></main></html>`,
      {
        status: 202,
        contentType: "text/html; charset=utf-8",
        headers: { ...headers, "content-language": language },
      },
    );
  }
  return yield* accepted(
    { "submission-id": submissionId, status: "received" },
    { status: 202, headers },
  );
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(16)));

/**
 * Answer a CORS preflight. A form accepts `POST` with a `Content-Type` header
 * from its allowed origins, or from every origin when it has none.
 */
const preflight = Effect.gen(function* () {
  const origin = yield* requestOrigin;
  const path = yield* Effect.option(HttpRouter.schemaPathParams(PublicFormPath));
  if (Option.isNone(path)) return empty(404, corsHeaders("unrestricted", origin));
  const intake = yield* SubmissionIntake;
  const match = yield* Effect.result(intake.matchOrigin(path.value.formId, origin));
  if (Result.isFailure(match)) return refusal(match.failure, origin);
  if (match.success === "unlisted" && Option.isSome(origin)) {
    return empty(403, corsHeaders("unlisted", origin));
  }
  return empty(204, {
    allow: "OPTIONS, POST",
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": preflightMaxAgeSeconds,
    ...corsHeaders(match.success, origin),
  });
});

export const submissionRoutes = Layer.mergeAll(
  HttpRouter.add("POST", "/f/:formId", receive),
  HttpRouter.add("OPTIONS", "/f/:formId", preflight),
);
