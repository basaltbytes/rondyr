import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, DateTime, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Digest } from "effect/crypto";

import { ClassificationPolicy } from "../src/domain/submissions/classification-policy.ts";
import { fileCache } from "./cache.ts";
import type { ClassifierName } from "./classifiers.ts";
import { type Corpus, loadCorpus } from "./corpus.ts";
import { encodeEscalation, evaluateEscalation, renderEscalation } from "./escalation.ts";
import { evaluate } from "./evaluate.ts";
import { buildReport, encodeReport } from "./report.ts";
import { renderMarkdown, renderSummary } from "./render.ts";
import { WorkersAi, workersAiDry, workersAiRest } from "./workers-ai.ts";

class InvalidOption extends Schema.TaggedError<InvalidOption, { readonly brand: unique symbol }>()(
  "InvalidOption",
  { summary: Schema.String },
) {}

const corpusFile = Argument.String("corpus").pipe(
  Argument.withDescription(
    "A JSON Lines corpus, next to its <name>.context.txt and optional <name>.domains.txt",
  ),
);
const classifier = Flag.Literals("classifier", ["jev", "openai", "both"]).pipe(
  Flag.withDefault("both"),
  Flag.withDescription("The classifier to evaluate"),
);
const dry = Flag.Boolean("dry").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Answer with fake scores instead of calling Workers AI"),
);
const concurrency = Flag.Int("concurrency").pipe(
  Flag.withDefault(4),
  Flag.withDescription("Calls in flight at once, from 1 to 16"),
);
const limit = Flag.Int("limit").pipe(
  Flag.optional,
  Flag.withDescription("Evaluate only the first N entries"),
);
const refresh = Flag.Boolean("refresh").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Call the model again even when the cache has a result"),
);
const escalation = Flag.Boolean("escalation").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Replay escalation from cached scores without calling Workers AI"),
);
const policy = Flag.String("policy").pipe(
  Flag.optional,
  Flag.withDescription("Path to a JSON classification policy to use in place of the defaults"),
);
const decodePolicy = Schema.decodeUnknownEffect(Schema.fromJsonString(ClassificationPolicy), {
  onExcessProperty: "error",
});
const out = Flag.String("out").pipe(
  Flag.withDefault("evals/out"),
  Flag.withDescription("Directory for the cache and the reports"),
);
const offline = Layer.succeed(WorkersAi, {
  transport: "workers-ai",
  run: () => Effect.die("Model calls are disabled in escalation replay."),
});

function limited(corpus: Corpus, count: Option.Option<number>): Corpus {
  if (Option.isNone(count)) return corpus;
  const [first, ...rest] = corpus.entries;
  return { ...corpus, entries: [first, ...rest.slice(0, Math.max(0, count.value - 1))] };
}

const evaluation = Command.make(
  "evaluate",
  { corpusFile, classifier, dry, concurrency, limit, refresh, escalation, out, policy },
  Effect.fn("Evaluation.command")(function* (flags) {
    if (flags.concurrency < 1 || flags.concurrency > 16) {
      return yield* InvalidOption.make({ summary: "--concurrency must be between 1 and 16." });
    }
    if (Option.isSome(flags.limit) && flags.limit.value < 1) {
      return yield* InvalidOption.make({ summary: "--limit must be at least 1." });
    }
    if (flags.escalation && flags.refresh) {
      return yield* InvalidOption.make({
        summary: "--escalation cannot be combined with --refresh.",
      });
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const override = Option.isNone(flags.policy)
      ? undefined
      : yield* fs.readFileString(flags.policy.value).pipe(Effect.flatMap(decodePolicy));
    const loaded = yield* loadCorpus(flags.corpusFile);
    const corpus = limited(loaded, flags.limit);
    const names: readonly ClassifierName[] =
      flags.classifier === "both" ? ["jev", "openai"] : [flags.classifier];
    const transport = flags.dry ? "dry" : "workers-ai";
    const base = path.join(flags.out, `${corpus.name}${flags.dry ? ".dry" : ""}`);
    if (flags.escalation) {
      const report = yield* evaluateEscalation(
        corpus,
        names,
        transport,
        flags.concurrency,
        override,
      );
      const json = yield* encodeEscalation(report);
      const markdown = renderEscalation(report);
      yield* fs.writeFileString(`${base}.escalation.json`, `${json}\n`);
      yield* fs.writeFileString(`${base}.escalation.md`, `${markdown}\n`);
      yield* Console.log(markdown);
      yield* Console.log(`\nReports: ${base}.escalation.json and ${base}.escalation.md.`);
      return;
    }
    yield* Console.error(
      `Scoring ${corpus.entries.length} entries of ${corpus.name} with ${names.join(" and ")}${flags.dry ? " (dry run)" : ""}.`,
    );
    const runs = yield* evaluate(corpus, {
      classifiers: names,
      concurrency: flags.concurrency,
      retryDelays: ["10 seconds", "30 seconds"],
      cache: flags.refresh ? "refresh" : "reuse",
    });

    const now = yield* DateTime.now;
    const report = buildReport(corpus, runs, transport, DateTime.formatIso(now), override);
    const reportBase = `${base}.report`;
    const json = yield* encodeReport(report);
    yield* fs.writeFileString(`${reportBase}.json`, `${json}\n`);
    yield* fs.writeFileString(`${reportBase}.md`, renderMarkdown(report));
    yield* Console.log(renderSummary(report));
    yield* Console.log(
      `\nReports: ${reportBase}.json and ${reportBase}.md, with the threshold sweep.`,
    );
  }),
).pipe(
  Command.provide((flags) =>
    Layer.mergeAll(
      flags.escalation ? offline : flags.dry ? workersAiDry : workersAiRest,
      fileCache(flags.out, flags.escalation ? "read-only" : "read-write"),
      Digest.layerWebCrypto,
    ),
  ),
  Command.withDescription(
    "Score a labeled corpus with the Worker's classifiers and report false positives, precision, recall, latency and cost.",
  ),
);

const program = Command.run(evaluation, { version: "1" });

/** Command.run has already printed its own errors: parse errors, help and version. */
function explain(failure: Effect.Error<typeof program>) {
  switch (failure._tag) {
    case "PlatformError":
    case "SchemaError":
      return Option.some(failure.message);
    case "InvalidOption":
    case "MissingCredentials":
      return Option.some(failure.summary);
    case "CorpusInvalid":
      return Option.some(
        [
          `${failure.file} is not a valid corpus:`,
          ...failure.problems.map(({ line, message }) =>
            line === 0 ? `  ${message}` : `  line ${line}: ${message.replaceAll("\n", " ")}`,
          ),
        ].join("\n"),
      );
    case "CloudflareRefused":
      return Option.some(
        `Cloudflare refused the API token (HTTP ${failure.status}). It needs the Account > Workers AI > Read permission on the account of CLOUDFLARE_ACCOUNT_ID.`,
      );
    case "UnexpectedModel":
      return Option.some(
        `The ${failure.classifier} adapter asked for ${failure.requested}, and evals/classifiers.ts expects ${failure.expected}. Update the registry and its prices.`,
      );
    case "UnsupportedGatewayOptions":
      return Option.some(
        `src/adapters/ai/gateway.ts sets options that the REST transport cannot send: ${failure.options.join(", ")}.`,
      );
    default:
      return Option.none();
  }
}

program.pipe(
  Effect.tapError((failure) =>
    Option.match(explain(failure), { onNone: () => Effect.void, onSome: Console.error }),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
