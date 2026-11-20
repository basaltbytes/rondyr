import { NodeServices } from "@effect/platform-node";
import { assert, it, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { EntryId, loadCorpus, parseCorpus } from "./corpus.ts";

const valid = [
  '{"id":"bb-spam-001","label":"spam","family":"price-probe","duplicates":3,"note":"Latin.","fields":{"name":"R","email":"r@probe.example","content":"Salve"}}',
  "",
  '{"id":"bb-legit-001","label":"legitimate","fields":{"content":"Is there room on Saturday?"}}',
].join("\n");

it.effect("accepts the corpus format and normalizes the context as the Worker does", () =>
  Effect.gen(function* () {
    const corpus = yield* parseCorpus("valid.jsonl", `${valid}\n`, `  ${"x".repeat(2100)}\n`);
    assert.deepEqual(
      corpus.entries.map(({ id, duplicates }) => [id, duplicates]),
      [
        [EntryId.make("bb-spam-001"), 3],
        [EntryId.make("bb-legit-001"), undefined],
      ],
    );
    assert.strictEqual(corpus.context, "x".repeat(2000));
  }),
);

it.effect("reports each bad line by number without repeating field values", () =>
  Effect.gen(function* () {
    const text = [
      valid,
      '{"id":"bb-spam-002","label":"spammy","fields":{"content":"secret visitor text"}}',
      '{"id":"bb-spam-003","label":"spam","familly":"typo","fields":{"content":"secret visitor text"}}',
      '{"id":"bb-spam-004","label":"spam","duplicates":0,"fields":{"content":"secret visitor text"}}',
      '{"id":"bb-spam-005","label":"spam","fields":{}}',
      '{"id":"bb-spam-001","label":"spam","fields":{"content":"secret visitor text"}}',
      "{not json",
    ].join("\n");
    const error = yield* Effect.flip(parseCorpus("bad.jsonl", text, ""));
    assert.deepEqual(
      error.problems.map(({ line }) => line),
      [4, 5, 6, 7, 8, 9],
    );
    assert.include(error.problems[1]?.message ?? "", "familly");
    assert.include(error.problems[4]?.message ?? "", "Duplicate id bb-spam-001");
    for (const { message } of error.problems) assert.notInclude(message, "secret visitor text");
  }),
);

layer(NodeServices.layer)((node) => {
  node.effect("pairs a corpus with its business context file and refuses one without it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const corpusFile = path.join(directory, "forms.jsonl");
      yield* fs.writeFileString(corpusFile, valid);
      const missing = yield* Effect.flip(loadCorpus(corpusFile));
      assert.strictEqual(missing.file, path.join(directory, "forms.context.txt"));

      yield* fs.writeFileString(path.join(directory, "forms.context.txt"), "Pottery classes\n");
      const corpus = yield* loadCorpus(corpusFile);
      assert.strictEqual(corpus.name, "forms");
      assert.strictEqual(corpus.context, "Pottery classes");
    }),
  );
});
