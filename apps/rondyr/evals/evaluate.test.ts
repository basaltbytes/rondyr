import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Ref } from "effect";
import { Digest } from "effect/crypto";

import { ResultCache, fileCache } from "./cache.ts";
import { type Corpus, loadCorpus, parseCorpus, weight } from "./corpus.ts";
import { evaluateEscalation } from "./escalation.ts";
import { type EvaluationOptions, evaluate, inputCacheKey } from "./evaluate.ts";
import { buildReport, encodeReport } from "./report.ts";
import { renderMarkdown } from "./render.ts";
import { replay } from "./replay.ts";
import { WorkersAi, WorkersAiFailure, workersAiDry } from "./workers-ai.ts";

const options: EvaluationOptions = {
  classifiers: ["jev", "openai"],
  concurrency: 4,
  retryDelays: ["0 millis", "0 millis"],
  cache: "reuse",
};

/** A WorkersAi whose answers come from a script, one per call, and that counts the calls. */
const scripted = Effect.fn(function* (
  answers: readonly (WorkersAiFailure | "valid" | "invalid")[],
) {
  const calls = yield* Ref.make(0);
  const dry = yield* Layer.build(workersAiDry);
  const ai = Context.get(dry, WorkersAi);
  const service = WorkersAi.of({
    transport: "dry",
    run: (model, input, gateway) =>
      Ref.getAndUpdate(calls, (count) => count + 1).pipe(
        Effect.flatMap((index) => {
          const answer = answers[Math.min(index, answers.length - 1)];
          if (answer === "valid") return ai.run(model, input, gateway);
          if (answer === "invalid" || answer === undefined) return Effect.succeed({ answers: [] });
          return Effect.fail(answer);
        }),
      ),
  });
  return { calls, layer: Layer.succeed(WorkersAi, service) };
});

/** Evaluates with a fresh cache service on `directory`, as a new run of the command would. */
const evaluateWith = Effect.fn(function* (
  ai: Layer.Layer<WorkersAi>,
  directory: string,
  corpus: Corpus,
  evaluation: EvaluationOptions,
) {
  const services = yield* Layer.build(Layer.mergeAll(ai, fileCache(directory)));
  return yield* evaluate(corpus, evaluation).pipe(Effect.provideContext(services));
});

layer(Layer.mergeAll(NodeServices.layer, Digest.layerWebCrypto))((it) => {
  it.effect("runs the synthetic corpus without credentials and reports no field value", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const corpus = yield* loadCorpus("evals/corpus/synthetic.jsonl");
      const runs = yield* evaluateWith(workersAiDry, directory, corpus, options);
      const report = buildReport(corpus, runs, "dry", "2026-11-20T00:00:00.000Z");
      const submissions = corpus.entries.reduce((total, entry) => total + weight(entry), 0);
      const labels = new Set(corpus.entries.map(({ label }) => label));
      assert.deepEqual([...labels].toSorted(), ["ambiguous", "legitimate", "off-topic", "spam"]);
      assert.strictEqual(report.classifiers.length, 2);
      for (const classifier of report.classifiers) {
        const cells = Object.values(classifier.confusion).flatMap((row) => Object.values(row));
        assert.deepEqual(
          [...new Set(classifier.decisions.map(({ id }) => id))].toSorted(),
          corpus.entries.map(({ id }) => id).toSorted(),
        );
        assert.strictEqual(
          cells.reduce((total, cell) => total + cell.submissions, 0),
          submissions,
        );
        assert.strictEqual(
          classifier.calls.scored,
          classifier.decisions.filter(({ decision }) => decision !== "repetition").length,
        );
        assert.strictEqual(classifier.calls.failed, 0);
        assert.deepEqual(classifier.confusion.legitimate.repetition, {
          entries: 0,
          submissions: 0,
        });
        const repeated = classifier.decisions.filter(({ decision }) => decision === "repetition");
        assert.deepEqual(
          repeated
            .filter(({ family }) => family === "repeat-sender" || family === "repeat-content")
            .map(({ id, firstOccurrence, duplicates }) => [id, firstOccurrence, duplicates]),
          [
            ["syn-repeat-content-002", 2, 3],
            ["syn-repeat-sender-004", 1, 1],
          ],
        );
        assert.deepEqual(
          classifier.decisions
            .filter(({ family }) => family === "double-submit")
            .map(({ firstOccurrence, duplicates }) => [firstOccurrence, duplicates]),
          [
            [1, 1],
            [2, 1],
          ],
        );
        assert.strictEqual(classifier.cost._tag, "Estimated");
      }

      const json = yield* encodeReport(report);
      const markdown = renderMarkdown(report);
      const values = corpus.entries.flatMap(({ fields }) =>
        Object.values(fields).filter((value) => value.length >= 12),
      );
      assert.isAbove(values.length, 30);
      for (const value of values) {
        assert.notInclude(json, value);
        assert.notInclude(markdown, value);
      }

      const rerun = yield* evaluateWith(workersAiDry, directory, corpus, options);
      for (const { results } of rerun) {
        assert.isTrue(
          results.every(
            ({ outcome }) =>
              outcome._tag === "Repetition" || (outcome._tag === "Scored" && outcome.cached),
          ),
        );
      }
    }),
  );

  const oneEntry = parseCorpus(
    "one.jsonl",
    '{"id":"bb-legit-001","label":"legitimate","fields":{"content":"Is there room on Saturday?"}}',
    "",
  ).pipe(Effect.map((parsed) => ({ name: "one", ...parsed })));
  const jevOnly = { ...options, classifiers: ["jev"] } as const;
  const refreshed = { ...jevOnly, cache: "refresh" } as const;

  it.effect("replays ambiguous cached scores without a Workers AI service", () =>
    Effect.gen(function* () {
      const corpus = yield* oneEntry;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const [occurrence] = replay(corpus);
      if (occurrence === undefined || occurrence.input === null) {
        return assert.fail("Expected an occurrence eligible for classification");
      }
      const { entry, input } = occurrence;
      const firstKey = yield* inputCacheKey("workers-ai", "jev", entry.id, input);
      const secondKey = yield* inputCacheKey("workers-ai", "openai", entry.id, input);
      const cache = yield* Layer.build(fileCache(directory));
      yield* Context.get(cache, ResultCache).put(firstKey, {
        scores: { model: "jev", spam: 0.4, solicitation: 0.03 },
        latencyMs: 1,
      });
      const escalate = Effect.gen(function* () {
        const readOnly = yield* Layer.build(fileCache(directory, "read-only"));
        return yield* evaluateEscalation(corpus, ["jev"], "workers-ai", 1).pipe(
          Effect.provideContext(readOnly),
        );
      });
      const missing = yield* escalate;
      assert.deepEqual(missing.directions[0]?.byLabel.legitimate.secondMissing, {
        entries: 1,
        submissions: 1,
      });

      yield* Context.get(cache, ResultCache).put(secondKey, {
        scores: { model: "openai", spam: 0.2, solicitation: 0.03 },
        latencyMs: 1,
      });
      const complete = yield* escalate;
      assert.deepEqual(complete.directions[0]?.byLabel.legitimate.accepted, {
        entries: 1,
        submissions: 1,
      });
      assert.deepEqual(complete.directions[0]?.byLabel.legitimate.secondMissing, {
        entries: 0,
        submissions: 0,
      });

      // The second model settles the spam doubt only; the primary scores keep their other rules.
      const primaryFinds = Effect.fnUntraced(function* (scores: {
        readonly solicitation: number;
        readonly relevance: number;
      }) {
        yield* Context.get(cache, ResultCache).put(firstKey, {
          scores: { model: "jev", spam: 0.4, ...scores },
          latencyMs: 1,
        });
        const report = yield* escalate;
        return report.directions[0]?.byLabel.legitimate;
      });
      const pitch = yield* primaryFinds({ solicitation: 0.93, relevance: 0.9 });
      assert.deepEqual(pitch?.solicitation, { entries: 1, submissions: 1 });
      assert.deepEqual(pitch?.accepted, { entries: 0, submissions: 0 });
      const offTopic = yield* primaryFinds({ solicitation: 0.03, relevance: 0.1 });
      assert.deepEqual(offTopic?.lowRelevance, { entries: 1, submissions: 1 });
      assert.deepEqual(offTopic?.accepted, { entries: 0, submissions: 0 });
    }),
  );

  it.effect("retries what the adapter marks retryable, with the saga's budget of three calls", () =>
    Effect.gen(function* () {
      const corpus = yield* oneEntry;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const unavailable = WorkersAiFailure.make({ status: 503, summary: "HTTP 503" });

      const recovering = yield* scripted([unavailable, "valid"]);
      const [recovered] = yield* evaluateWith(recovering.layer, directory, corpus, jevOnly);
      assert.strictEqual(recovered?.results[0]?.outcome._tag, "Scored");
      const recoveringCalls = yield* Ref.get(recovering.calls);
      assert.strictEqual(recoveringCalls, 2);

      const down = yield* scripted([unavailable]);
      const [failed] = yield* evaluateWith(down.layer, directory, corpus, refreshed);
      assert.deepEqual(failed?.results[0]?.outcome, {
        _tag: "Failed",
        attempts: 3,
        retryable: true,
        httpStatus: 503,
        summary: "HTTP 503",
      });
      const downCalls = yield* Ref.get(down.calls);
      assert.strictEqual(downCalls, 3);

      const invalid = yield* scripted(["invalid"]);
      const [permanent] = yield* evaluateWith(invalid.layer, directory, corpus, refreshed);
      assert.deepEqual(permanent?.results[0]?.outcome, {
        _tag: "Failed",
        attempts: 1,
        retryable: false,
        summary: "The adapter refused the model's answer.",
      });
    }),
  );

  it.effect("stops the run when Cloudflare refuses the token", () =>
    Effect.gen(function* () {
      const corpus = yield* oneEntry;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const refused = yield* scripted([
        WorkersAiFailure.make({ status: 401, summary: "HTTP 401" }),
      ]);
      const error = yield* Effect.flip(evaluateWith(refused.layer, directory, corpus, jevOnly));
      assert.strictEqual(error._tag, "CloudflareRefused");
      const refusedCalls = yield* Ref.get(refused.calls);
      assert.strictEqual(refusedCalls, 1);
    }),
  );
});
