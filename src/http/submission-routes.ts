import { ByteSize, Effect, Layer, Match, Option, Result, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { SubmissionFields } from "../domain/submissions/submission-fields.ts";
import { SubmissionId } from "../domain/submissions/submission.id.ts";
import { publishSubmission } from "../jobs/submission-outbox.ts";
import { BackgroundTasks } from "../ports/background-tasks.ts";
import {
  SubmissionIntake,
  type FormNotFound,
  type FormRateLimited,
  type OriginMatch,
  type OriginRefused,
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
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(SubmissionFields));
const decodeFields = Schema.decodeUnknownEffect(SubmissionFields);

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

const decodeUrlEncoded = Effect.fnUntraced(function* (body: string) {
  const entries = new URLSearchParams(body);
  const fields = yield* decodeFields(Object.fromEntries(entries));
  if (entries.size !== Object.keys(fields).length) return yield* MalformedForm.make();
  return fields;
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

const readFields = Effect.fnUntraced(
  function* (request: HttpServerRequest.HttpServerRequest) {
    const media = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    const json = media === "application/json";
    if (!json && media !== "application/x-www-form-urlencoded") {
      return yield* InvalidBody.make({ status: 415 });
    }
    const body = yield* request.text;
    const fields = json ? yield* decodeJson(body) : yield* decodeUrlEncoded(body);
    return { json, fields };
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

function refusal(
  error: FormNotFound | FormRateLimited | OriginRefused | StorageUnavailable,
  origin: Option.Option<string>,
) {
  return Match.valueTags(error, {
    FormNotFound: () => empty(404, corsHeaders("unrestricted", origin)),
    // A browser cannot read this response: it has no Access-Control-Allow-Origin.
    OriginRefused: () => empty(403, corsHeaders("unlisted", origin)),
    FormRateLimited: ({ origins }) =>
      empty(429, {
        "retry-after": "60",
        "access-control-expose-headers": "retry-after",
        ...corsHeaders(origins, origin),
      }),
    StorageUnavailable: () => empty(503, corsHeaders("unrestricted", origin)),
  });
}

const requestOrigin = Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
  Option.fromNullishOr(request.headers.origin),
);

const receive = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const origin = yield* requestOrigin;
  const path = yield* Effect.option(HttpRouter.schemaPathParams(PublicFormPath));
  if (Option.isNone(path)) return empty(400, corsHeaders("unrestricted", origin));
  const { formId } = path.value;
  const read = yield* Effect.result(readFields(request));
  if (Result.isFailure(read)) return yield* refuseBody(formId, origin, read.failure.status);
  const { json, fields } = read.success;
  const intake = yield* SubmissionIntake;
  const received = yield* Effect.result(intake.receive(formId, fields, origin));
  if (Result.isFailure(received)) return refusal(received.failure, origin);
  const { submissionId, origins } = received.success;
  // The cron publishes the event later if this attempt fails or never runs.
  const tasks = yield* BackgroundTasks;
  yield* tasks.run(
    publishSubmission(submissionId).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Direct outbox publication failed", { tag: error._tag }),
      ),
      Effect.ignore,
    ),
  );
  const headers = { "cache-control": "no-store", ...corsHeaders(origins, origin) };
  const browser =
    request.headers.accept
      ?.split(",")
      .some((value) => value.split(";", 1)[0]?.trim() === "text/html") ?? false;
  if (!json && browser) {
    return HttpServerResponse.text(
      '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Message reçu</title><main><h1>Message reçu</h1><p>Votre message a été enregistré.</p></main></html>',
      { status: 202, contentType: "text/html; charset=utf-8", headers },
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
