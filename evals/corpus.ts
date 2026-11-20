import { Effect, FileSystem, Path, Schema } from "effect";

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

/** One line of a corpus file. `duplicates` is the number of identical submissions it stands for. */
export const CorpusEntry = Schema.Struct({
  id: EntryId,
  label: Label,
  family: Schema.optionalKey(Family),
  duplicates: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1e6 }))),
  note: Schema.optionalKey(Schema.String),
  /** Where the submission came from, and the day it was received (`YYYY-MM-DD`). Never sent to a classifier. */
  source: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  received: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u))),
  fields: SubmissionFields,
});

export type CorpusEntry = typeof CorpusEntry.Type;

export interface Corpus {
  readonly name: string;
  /** The business context as the Worker sends it to the classifier: trimmed, at most 2,000 characters. */
  readonly context: string;
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

// Same normalization as src/adapters/ai/classifier.ts applies to a form's business context.
export function classifierContext(raw: string) {
  return raw.trim().slice(0, 2000);
}

/**
 * Parses a JSON Lines corpus. Blank lines are ignored. Every invalid line is reported with its
 * line number; schema messages name the failing path, never the value.
 */
export const parseCorpus = Effect.fn("Corpus.parse")(function* (
  file: string,
  text: string,
  context: string,
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
  return { context: classifierContext(context), entries: [first, ...rest] } as const;
});

/** `name.jsonl` is paired with `name.context.txt`, the business context of its form. */
export function contextFileOf(path: Path.Path, corpusFile: string) {
  return path.join(
    path.dirname(corpusFile),
    `${path.basename(corpusFile, path.extname(corpusFile))}.context.txt`,
  );
}

function unreadable(file: string, message: string) {
  return CorpusInvalid.make({ file, problems: [{ line: 0, message }] });
}

export const loadCorpus = Effect.fn("Corpus.load")(function* (corpusFile: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contextFile = contextFileOf(path, corpusFile);
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
  const parsed = yield* parseCorpus(corpusFile, text, context);
  const name = path.basename(corpusFile, path.extname(corpusFile));
  return { name, ...parsed } satisfies Corpus;
});
