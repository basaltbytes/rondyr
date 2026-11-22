import { Option, Result, Schema, SchemaAST, SchemaIssue } from "effect";

import type { SubmissionFields } from "../../submissions/submission-fields.ts";
import type { DeliveryId } from "../delivery.ts";

// A connector sends each accepted message of a form to one outside service,
// such as a Discord channel or an Airtable table. It is a value built by
// `defineConnector`: the settings an admin types, and a pure function from
// these settings and a message to one HTTPS request. Rondyr does the rest for
// every connector: the admin API and the dashboard form, the secrets sealed in
// D1, the delivery with its retries and its history, and the test send.
// docs/writing-a-connector.md explains how to add one.

/** One string per setting: what an admin types, and what Rondyr stores. */
export const ConnectorSettings = Schema.Record(Schema.String, Schema.String);
export type ConnectorSettings = typeof ConnectorSettings.Type;

/** What a connector sends: an accepted submission, or a test from the dashboard. */
export interface ConnectorMessage {
  /** A `test` has the fields of a test message, and no visitor sent it. */
  readonly kind: "submission" | "test";
  /** The delivery ID, or the ID of the test. It is the same on every attempt. */
  readonly id: DeliveryId;
  /** The same for every delivery of the submission. A test has its own ID here. */
  readonly submissionId: string;
  /** Milliseconds since the epoch. */
  readonly receivedAt: number;
  readonly form: { readonly publicId: string; readonly name: string };
  readonly fields: typeof SubmissionFields.Type;
}

export const ConnectorHeaders = Schema.Record(Schema.String, Schema.String);

/** The one request of an attempt. Rondyr reads only the status of its response. */
export interface ConnectorRequest {
  readonly method: "POST" | "PATCH";
  /** An HTTPS URL on one of the hosts of the connector. */
  readonly url: string;
  /** Headers besides `content-type`, such as `authorization`. */
  readonly headers: typeof ConnectorHeaders.Type;
  /** Sent as JSON. */
  readonly body: Schema.Json;
}

/** A setting of a connector, as the dashboard needs it to draw the form. */
export interface ConnectorField {
  readonly name: string;
  /** Sealed in D1 with `RONDYR_SECRETS_KEY`, and never returned by the API. */
  readonly secret: boolean;
  readonly optional: boolean;
}

/** Why the settings an admin typed are refused. */
export const SettingsRefusalReason = Schema.Literals(["missing", "invalid", "unknown"]);

export const SettingsRefusal = Schema.Struct({
  /** The setting that is refused. */
  field: Schema.String,
  reason: SettingsRefusalReason,
});

export interface Connector<Type extends string = string> {
  /** The type of its destinations in the API and in `notification_targets.type`. */
  readonly type: Type;
  /** The name of the service, a proper noun that no language translates. */
  readonly label: string;
  /** The hosts of the service. A request to another host is never sent. */
  readonly hosts: ReadonlyArray<string>;
  readonly fields: ReadonlyArray<ConnectorField>;
  /** Check the settings an admin typed. The values returned are the ones to store. */
  readonly parseSettings: (
    typed: ConnectorSettings,
  ) => Result.Result<ConnectorSettings, typeof SettingsRefusal.Type>;
  /** The request that carries `message`, or none when the stored settings no longer fit. */
  readonly request: (
    stored: ConnectorSettings,
    message: ConnectorMessage,
  ) => Option.Option<ConnectorRequest>;
  /** What an HTTP status of the service means, added to the error of an attempt. */
  readonly explain: (status: number) => Option.Option<string>;
}

interface ConnectorDefinition<Type extends string, Fields extends Schema.Struct.Fields> {
  readonly type: Type;
  readonly label: string;
  readonly hosts: ReadonlyArray<string>;
  /** One key per setting. Each one decodes the string an admin typed. */
  readonly settings: Schema.Struct<Fields> & Schema.Codec<Schema.Struct<Fields>["Type"], unknown>;
  /** The settings that are secrets, such as a token or a URL that contains one. */
  readonly secrets: ReadonlyArray<keyof Fields & string>;
  /** Build the request of one attempt. It runs again, with the same message, on a retry. */
  readonly request: (
    settings: Schema.Struct<Fields>["Type"],
    message: ConnectorMessage,
  ) => ConnectorRequest;
  /** Sentences for the statuses that tell an admin what to fix. They never quote a response. */
  readonly statusHints: ReadonlyMap<number, string>;
}

const firstIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Declare a connector. `settings` is the single description of what an admin
 * types: the admin API checks requests with it, the dashboard draws its form
 * from its keys, and `request` receives its decoded value.
 */
export function defineConnector<const Type extends string, Fields extends Schema.Struct.Fields>(
  definition: ConnectorDefinition<Type, Fields>,
): Connector<Type> {
  const decode = Schema.decodeUnknownResult(definition.settings);
  const fields = Object.entries(definition.settings.fields).map(
    ([name, field]): ConnectorField => ({
      name,
      secret: definition.secrets.some((secret) => secret === name),
      optional: SchemaAST.isOptional(field.ast),
    }),
  );
  const known = new Set(fields.map(({ name }) => name));

  return {
    type: definition.type,
    label: definition.label,
    hosts: definition.hosts,
    fields,
    parseSettings: (typed) => {
      // An empty value is a setting left out.
      const given = Object.fromEntries(
        Object.entries(typed)
          .map(([name, value]) => [name, value.trim()] as const)
          .filter(([, value]) => value !== ""),
      );
      const unknown = Object.keys(given).find((name) => !known.has(name));
      if (unknown !== undefined) return Result.fail({ field: unknown, reason: "unknown" });
      const decoded = decode(given);
      if (Result.isSuccess(decoded)) return Result.succeed(given);
      const [issue] = firstIssue(decoded.failure.issue).issues;
      const field = String(issue?.path?.[0] ?? "");
      return Result.fail({ field, reason: Object.hasOwn(given, field) ? "invalid" : "missing" });
    },
    request: (stored, message) =>
      Result.match(decode(stored), {
        onSuccess: (settings) => Option.some(definition.request(settings, message)),
        onFailure: () => Option.none(),
      }),
    explain: (status) => Option.fromUndefinedOr(definition.statusHints.get(status)),
  };
}

/** Cut `text` to `max` UTF-16 units, ending with an ellipsis, without splitting a character. */
export function cut(text: string, max: number) {
  if (text.length <= max) return text;
  const kept = text.slice(0, Math.max(0, max - 1));
  // A high surrogate at the end has lost its low surrogate.
  const whole = /[\u{D800}-\u{DBFF}]$/u.test(kept) ? kept.slice(0, -1) : kept;
  return `${whole}…`;
}

// C0 and C1 control characters and the Unicode line separators.
const controls = /[\p{Cc}\u{2028}\u{2029}]+/gu;

/** One line of text: line breaks and control characters become single spaces. */
export function oneLine(text: string) {
  return text.replace(controls, " ").replace(/\s+/gu, " ").trim();
}

/**
 * A setting on one line, of 1 to `max` characters, without a control character
 * or a lone surrogate, which a URL or a JSON body cannot carry.
 */
export function lineOf(max: number) {
  return Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
    Schema.makeFilter(
      (text: string) =>
        (text.isWellFormed() && !/[\p{Cc}\u{2028}\u{2029}]/u.test(text)) ||
        "Expected a single line of text",
    ),
  );
}
