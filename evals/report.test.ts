import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { EntryId, parseCorpus } from "./corpus.ts";
import type { ClassifierRun, Outcome } from "./evaluate.ts";
import { classifierReport } from "./report.ts";

const lines = [
  ["legit-1", "legitimate", 1],
  ["legit-2", "legitimate", 2],
  ["legit-0", "legitimate", 1],
  ["off-1", "off-topic", 1],
  ["spam-1", "spam", 5],
  ["spam-2", "spam", 3],
  ["spam-3", "spam", 1],
  ["amb-1", "ambiguous", 4],
] as const;

const scoresById = new Map([
  ["legit-1", { spam: 0.1, solicitation: 0.4, relevance: 0.9 }],
  ["legit-2", { spam: 0.5, solicitation: 0.2, relevance: 0.9 }],
  ["legit-0", { spam: 0.8, solicitation: 0.7, relevance: 0.9 }],
  ["off-1", { spam: 0.1, solicitation: 0, relevance: 0.1 }],
  ["spam-1", { spam: 0.9, solicitation: 0.8, relevance: 0.2 }],
  ["spam-2", { spam: 0.2, solicitation: 0.45, relevance: 0.8 }],
  ["amb-1", { spam: 0.4, solicitation: 0, relevance: 0.5 }],
]);

const corpusText = lines
  .map(
    ([id, label, duplicates]) =>
      `{"id":"${id}","label":"${label}","family":"family-${label}","duplicates":${duplicates},"fields":{"content":"${id}"}}`,
  )
  .join("\n");

const run = Effect.gen(function* () {
  const corpus = yield* parseCorpus("report.jsonl", corpusText, "Pottery classes");
  const results = corpus.entries.map((entry, index) => {
    const scores = scoresById.get(entry.id);
    const outcome: Outcome =
      scores === undefined
        ? {
            _tag: "Failed",
            attempts: 3,
            retryable: true,
            httpStatus: 503,
            summary: "Workers AI answered HTTP 503.",
          }
        : {
            _tag: "Scored",
            cached: index === 0,
            call: {
              scores: { model: "jev-1.13.0", ...scores },
              latencyMs: (index + 1) * 10,
              usage: { input_tokens: 1000, output_tokens: 0 },
            },
          };
    return { entry, outcome };
  });
  return { classifier: "jev", model: "typesafe/jev", results } satisfies ClassifierRun;
});

it.effect("counts entries and submissions weighted by duplicates", () =>
  Effect.gen(function* () {
    const evaluated = yield* run;
    const report = classifierReport(evaluated);

    assert.deepEqual(
      report.falsePositives.map(({ id, decision }) => [id, decision]),
      [
        [EntryId.make("legit-0"), "probable-spam"],
        [EntryId.make("legit-2"), "ambiguous"],
      ],
    );
    assert.deepEqual(
      report.spamAccepted.map(({ id, family }) => [id, family]),
      [[EntryId.make("spam-2"), "family-spam"]],
    );
    assert.deepEqual(
      report.offTopicQuarantined.map(({ id }) => id),
      [EntryId.make("off-1")],
    );
    assert.deepEqual(report.failures, [
      {
        id: EntryId.make("spam-3"),
        label: "spam",
        attempts: 3,
        retryable: true,
        httpStatus: 503,
        summary: "Workers AI answered HTTP 503.",
      },
    ]);

    assert.deepEqual(report.confusion.legitimate.ambiguous, { entries: 1, submissions: 2 });
    assert.deepEqual(report.confusion.spam["probable-spam"], { entries: 1, submissions: 5 });
    assert.deepEqual(report.confusion.spam["classification-error"], { entries: 1, submissions: 1 });
    assert.deepEqual(report.confusion.ambiguous.ambiguous, { entries: 1, submissions: 4 });

    const { quarantineSpam } = report;
    assert.deepEqual(quarantineSpam.othersQuarantined, { entries: 3, submissions: 4 });
    assert.deepEqual(quarantineSpam.precision, { entries: 1 / 4, submissions: 5 / 9 });
    assert.deepEqual(quarantineSpam.recall, { entries: 1 / 2, submissions: 5 / 8 });

    assert.deepEqual(report.calls, { scored: 7, fromCache: 1, failed: 1 });
    assert.deepEqual(report.returnedModels, [{ model: "jev-1.13.0", entries: 7 }]);
    assert.deepEqual(report.latencyMs, { calls: 7, p50: 40, p90: 80, p95: 80, p99: 80, max: 80 });
    assert.strictEqual(report.cost._tag, "Estimated");
    if (report.cost._tag === "Estimated")
      assert.closeTo(report.cost.usd, (7000 * 0.042) / 1e6, 1e-12);
  }),
);

it.effect("recomputes the counts for other thresholds from the recorded scores", () =>
  Effect.gen(function* () {
    const evaluated = yield* run;
    const report = classifierReport(evaluated);
    const at = (probableSpam: number, ambiguous: number) =>
      report.sweep.spam.find(
        ({ thresholds }) =>
          thresholds.probableSpam === probableSpam && thresholds.ambiguous === ambiguous,
      );

    assert.deepInclude(at(0.7, 0.3), {
      falsePositives: { entries: 2, submissions: 3 },
      spamAccepted: { entries: 1, submissions: 3 },
      legitimateAsProbableSpam: { entries: 1, submissions: 1 },
    });
    assert.deepInclude(at(0.85, 0.55), {
      falsePositives: { entries: 1, submissions: 1 },
      legitimateAsProbableSpam: { entries: 0, submissions: 0 },
    });
    assert.deepInclude(at(0.95, 0.15), { spamAccepted: { entries: 0, submissions: 0 } });
    const lowRelevance = report.sweep.relevance.find(
      ({ thresholds }) => thresholds.lowRelevance === 0.05,
    );
    assert.deepInclude(lowRelevance, { offTopicQuarantined: { entries: 0, submissions: 0 } });
  }),
);

it.effect("counts extra solicitation quarantines without attributing spam quarantines to it", () =>
  Effect.gen(function* () {
    const evaluated = yield* run;
    const { solicitation } = classifierReport(evaluated).sweep;
    const at = (threshold: number) =>
      solicitation.find((point) => point.thresholds.solicitation === threshold);

    assert.deepInclude(at(0.35), {
      falsePositives: { entries: 3, submissions: 4 },
      legitimateAsSolicitation: { entries: 1, submissions: 1 },
    });
    assert.deepInclude(at(0.4), {
      falsePositives: { entries: 2, submissions: 3 },
      legitimateAsSolicitation: { entries: 0, submissions: 0 },
      spamAsSolicitation: { entries: 1, submissions: 3 },
      spamAccepted: { entries: 0, submissions: 0 },
    });
    assert.deepInclude(at(0.8), {
      spamAsSolicitation: { entries: 0, submissions: 0 },
      spamAccepted: { entries: 1, submissions: 3 },
    });
  }),
);
