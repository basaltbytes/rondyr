import { ByteSize, Effect, Schema } from "effect";
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
import { SubmissionIntake } from "../ports/intake.ts";

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

function empty(status: number, headers?: Record<string, string>) {
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

const receive = Effect.gen(function* () {
  const { formId } = yield* HttpRouter.schemaPathParams(PublicFormPath);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const media = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  const json = media === "application/json";
  if (!json && media !== "application/x-www-form-urlencoded") return empty(415);
  const body = yield* request.text;
  const fields = json ? yield* decodeJson(body) : yield* decodeUrlEncoded(body);
  const intake = yield* SubmissionIntake;
  const submissionId = yield* intake.receive(formId, fields);
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
  const browser =
    request.headers.accept
      ?.split(",")
      .some((value) => value.split(";", 1)[0]?.trim() === "text/html") ?? false;
  if (!json && browser) {
    return HttpServerResponse.text(
      '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Message reçu</title><main><h1>Message reçu</h1><p>Votre message a été enregistré.</p></main></html>',
      {
        status: 202,
        contentType: "text/html; charset=utf-8",
        headers: { "cache-control": "no-store" },
      },
    );
  }
  return yield* accepted(
    { "submission-id": submissionId, status: "received" },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}).pipe(
  Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(16)),
  Effect.catchTags({
    SchemaError: () => Effect.succeed(empty(400)),
    MalformedForm: () => Effect.succeed(empty(400)),
    HttpServerError: ({ reason }) =>
      Effect.succeed(
        empty(reason._tag === "RequestParseError" && reason.reason === "BodyTooLarge" ? 413 : 400),
      ),
    FormNotFound: () => Effect.succeed(empty(404)),
    FormRateLimited: () => Effect.succeed(empty(429, { "retry-after": "60" })),
    StorageUnavailable: () => Effect.succeed(empty(503)),
  }),
);

export const submissionRoutes = HttpRouter.add("POST", "/f/:formId", receive);
