import { ByteSize, Clock, DateTime, Effect, Layer, Option, Schema, Stream } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { RetentionPeriods } from "../../domain/organizations/retention.ts";
import { InboxFilter } from "../../domain/submissions/inbox.ts";
import {
  csvHeader,
  csvLine,
  ExportFormat,
  ExportLine,
  exportLine,
  maxExportedSubmissions,
  maxFieldColumns,
  orderFieldNames,
  type ExportedSubmission,
} from "../../domain/submissions/submission-export.ts";
import { OrganizationId, SubmissionId } from "../../domain/submissions/submission.id.ts";
import { SubmissionExports } from "../ports/submission-exports.ts";
import { SubmissionRetention } from "../ports/submission-retention.ts";
import { authorize } from "./organization-access.ts";

const OrganizationPath = Schema.Struct({ organizationId: OrganizationId });
const SubmissionPath = OrganizationPath.mapFields((fields) => ({
  ...fields,
  submissionId: SubmissionId,
}));
const ExportParams = OrganizationPath.mapFields((fields) => ({
  ...fields,
  format: ExportFormat,
  status: InboxFilter.fields.status,
  form: InboxFilter.fields.formPublicId,
  q: InboxFilter.fields.search,
}));

const jsonOptions = { headers: { "cache-control": "no-store" } };
const periodsJson = HttpServerResponse.schemaJson(RetentionPeriods);
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(ExportLine));
const empty = (status: number) =>
  Effect.succeed(HttpServerResponse.empty({ status, ...jsonOptions }));

const withErrors = <A, E, R>(route: Effect.Effect<A, E, R>) =>
  route.pipe(
    Effect.catchCause((cause) => {
      const error = cause.reasons.find((reason) => reason._tag === "Fail");
      if (error === undefined) return empty(503);
      return Effect.catchTags(Effect.fail(error.error), {
        ReviewUnauthorized: () => empty(401),
        AuthOriginRefused: () => empty(403),
        PermissionDenied: () => empty(403),
        OrganizationNotFound: () => empty(404),
        SubmissionRetentionNotFound: () => empty(404),
        SubmissionNotFound: () => empty(404),
        SchemaError: () => empty(400),
        HttpServerError: () => empty(400),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

/** Where the export is: the cursor of the next page, and how many messages it sent. */
interface ExportPosition {
  readonly after: string | null;
  readonly sent: number;
}

/** Rows of a page of the export, in 500 messages per D1 query. */
const pageSize = 500;

const contentTypes = {
  csv: "text/csv; charset=utf-8",
  jsonl: "application/x-ndjson; charset=utf-8",
} as const;

/**
 * The filtered list of the Inbox, newest first, as CSV or JSON Lines, with at
 * most `maxExportedSubmissions` messages. The body streams page by page, so a
 * large export never sits whole in the Worker's memory.
 */
const exportSubmissions = Effect.gen(function* () {
  const { organizationId, format, status, form, q } = yield* HttpRouter.schemaParams(ExportParams);
  yield* authorize(organizationId, "export-submissions");
  const filter = {
    ...(status !== undefined && { status }),
    ...(form !== undefined && { formPublicId: form }),
    ...(q !== undefined && { search: q }),
  };
  const exports = yield* SubmissionExports;
  const { fieldNames, moreFieldNames, truncated } = yield* exports.outline(
    organizationId,
    filter,
    maxExportedSubmissions,
    maxFieldColumns,
  );
  const columns = { fieldNames: orderFieldNames(fieldNames), otherFields: moreFieldNames };
  const render = (rows: ReadonlyArray<ExportedSubmission>) =>
    format === "csv"
      ? Effect.map(
          Effect.forEach(rows, (row) => csvLine(row, columns)),
          (lines) => lines.join(""),
        )
      : Effect.map(
          Effect.forEach(rows, (row) => encodeLine(exportLine(row))),
          (lines) => lines.map((line) => `${line}\n`).join(""),
        );
  const start: ExportPosition = { after: null, sent: 0 };
  const pages = Stream.paginate(start, ({ after, sent }) =>
    exports
      .page(organizationId, filter, after, Math.min(pageSize, maxExportedSubmissions - sent))
      .pipe(
        Effect.map(({ rows, cursor }) => {
          const total = sent + rows.length;
          const next =
            cursor === null || total >= maxExportedSubmissions
              ? Option.none()
              : Option.some({ after: cursor, sent: total });
          return [[rows], next] as const;
        }),
      ),
  );
  const body = Stream.concat(
    Stream.make(format === "csv" ? csvHeader(columns) : ""),
    pages.pipe(Stream.mapEffect(render)),
  ).pipe(Stream.encodeText);
  const now = yield* Clock.currentTimeMillis;
  const day = DateTime.formatIsoDateUtc(DateTime.makeUnsafe(now));
  return HttpServerResponse.stream(body, {
    contentType: contentTypes[format],
    headers: {
      ...jsonOptions.headers,
      "content-disposition": `attachment; filename="rondyr-messages-${day}.${format}"`,
      // The list had more messages than one export holds: these are the newest ones.
      "rondyr-export-truncated": String(truncated),
    },
  });
});

/** Delete a message, its outbox event, its inbox row and its deliveries, and log it. */
const remove = Effect.gen(function* () {
  const { organizationId, submissionId } = yield* HttpRouter.schemaPathParams(SubmissionPath);
  const { userId } = yield* authorize(organizationId, "delete-submissions");
  const retention = yield* SubmissionRetention;
  yield* retention.remove({ userId, organizationId }, submissionId);
  return HttpServerResponse.empty({ status: 204, ...jsonOptions });
});

const readPeriods = Effect.gen(function* () {
  const { organizationId } = yield* HttpRouter.schemaPathParams(OrganizationPath);
  const { userId } = yield* authorize(organizationId, "manage-retention");
  const retention = yield* SubmissionRetention;
  const periods = yield* retention.periods({ userId, organizationId });
  return yield* periodsJson(periods, jsonOptions);
});

const savePeriods = Effect.gen(function* () {
  const { organizationId } = yield* HttpRouter.schemaPathParams(OrganizationPath);
  const { userId } = yield* authorize(organizationId, "manage-retention");
  const input = yield* HttpServerRequest.schemaBodyJson(RetentionPeriods, {
    onExcessProperty: "error",
  });
  const retention = yield* SubmissionRetention;
  const periods = yield* retention.savePeriods({ userId, organizationId }, input);
  return yield* periodsJson(periods, jsonOptions);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)));

const organization = "/api/organizations/:organizationId";

export const submissionAdministrationRoutes = Layer.mergeAll(
  HttpRouter.add("GET", `${organization}/submission-export`, withErrors(exportSubmissions)),
  HttpRouter.add("DELETE", `${organization}/submissions/:submissionId`, withErrors(remove)),
  HttpRouter.add("GET", `${organization}/retention`, withErrors(readPeriods)),
  HttpRouter.add("PUT", `${organization}/retention`, withErrors(savePeriods)),
);
