import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect";

import { OrganizationDomainList } from "../src/domain/organizations/organization-domain.ts";
import { classifierContext } from "../src/domain/submissions/classifier-input.ts";
import { SubmissionFields } from "../src/domain/submissions/submission-fields.ts";

export const Label = Schema.Literals(["legitimate", "spam", "ambiguous", "off-topic"]);

export type Label = typeof Label.Type;

export const EntryId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u, {
    message: "Expected an id of letters, digits, dots, dashes or underscores",
  }),
).pipe(Schema.brand("EntryId"));

export type EntryId = typeof EntryId.Type;

export const Family = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u, { message: "Expected a kebab-case family" }),
);

const ReceivedDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u),
  Schema.makeFilter(
    (value) =>
      Option.exists(DateTime.make(value), (date) => DateTime.formatIsoDateUtc(date) === value) ||
      "Expected a valid calendar date",
  ),
);

/** One line of a corpus file. `duplicates` is the number of identical submissions it stands for. */
export const CorpusEntry = Schema.Struct({
  id: EntryId,
  label: Label,
  family: Schema.optionalKey(Family),
  duplicates: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1e6 }))),
  note: Schema.optionalKey(Schema.String),
  /** Where the submission came from, and the day it was received (`YYYY-MM-DD`). Never sent to a classifier. */
  source: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  received: Schema.optionalKey(ReceivedDate),
  fields: SubmissionFields,
});

export type CorpusEntry = typeof CorpusEntry.Type;

export interface Corpus {
  readonly name: string;
  /** The same trimmed and bounded business context that the Worker sends to the classifier. */
  readonly context: string;
  readonly domains: OrganizationDomainList;
  readonly entries: readonly [CorpusEntry, ...CorpusEntry[]];
}

export interface CorpusProblem {
  readonly line: number;
  readonly message: string;
}

export class CorpusInvalid extends Schema.TaggedError<
  CorpusInvalid,
  { readonly brand: unique symbol }
>()("CorpusInvalid", {
  file: Schema.String,
  problems: Schema.Array(Schema.Struct({ line: Schema.Int, message: Schema.String })),
}) {}

const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(CorpusEntry));

export function weight(entry: CorpusEntry) {
  return entry.duplicates ?? 1;
}

/**
 * Parses a JSON Lines corpus. Blank lines are ignored. Every invalid line is reported with its
 * line number; schema messages name the failing path, never the value.
 */
export const parseCorpus = Effect.fn("Corpus.parse")(function* (
  file: string,
  text: string,
  context: string,
  domains: OrganizationDomainList = [],
) {
  const problems: CorpusProblem[] = [];
  const entries: CorpusEntry[] = [];
  const seen = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim() === "") continue;
    const decoded = yield* decodeLine(line, { onExcessProperty: "error" }).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      problems.push({ line: index + 1, message: decoded.failure.message });
      continue;
    }
    if (seen.has(decoded.success.id)) {
      problems.push({ line: index + 1, message: `Duplicate id ${decoded.success.id}` });
      continue;
    }
    seen.add(decoded.success.id);
    entries.push(decoded.success);
  }
  const [first, ...rest] = entries;
  if (first === undefined && problems.length === 0) {
    problems.push({ line: 0, message: "The corpus has no entry" });
  }
  if (problems.length > 0 || first === undefined) {
    return yield* CorpusInvalid.make({ file, problems });
  }
  return { context: classifierContext(context), domains, entries: [first, ...rest] } as const;
});

function unreadable(file: string, message: string) {
  return CorpusInvalid.make({ file, problems: [{ line: 0, message }] });
}

export const loadCorpus = Effect.fn("Corpus.load")(function* (corpusFile: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const name = path.basename(corpusFile, path.extname(corpusFile));
  const directory = path.dirname(corpusFile);
  const contextFile = path.join(directory, `${name}.context.txt`);
  const domainsFile = path.join(directory, `${name}.domains.txt`);
  const text = yield* fs
    .readFileString(corpusFile)
    .pipe(Effect.mapError(() => unreadable(corpusFile, "The corpus file cannot be read")));
  const context = yield* fs
    .readFileString(contextFile)
    .pipe(
      Effect.mapError(() =>
        unreadable(
          contextFile,
          "The business context file is missing. Write the form's business context in it, or leave it empty to evaluate without context",
        ),
      ),
    );
  const domainText = yield* fs.readFileString(domainsFile).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(""),
    ),
    Effect.mapError(() => unreadable(domainsFile, "The domains file cannot be read")),
  );
  const domains = yield* Schema.decodeEffect(OrganizationDomainList)(
    domainText.split(/\r?\n/u).filter((line) => line.trim() !== ""),
  ).pipe(
    Effect.mapError(() =>
      unreadable(
        domainsFile,
        "Expected up to ten distinct lowercase ASCII hostnames, one per line",
      ),
    ),
  );
  const parsed = yield* parseCorpus(corpusFile, text, context, domains);
  return { name, ...parsed } satisfies Corpus;
});
