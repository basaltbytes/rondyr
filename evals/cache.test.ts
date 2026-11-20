import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { Digest } from "effect/crypto";

import { ResultCache, cacheKey, fileCache, inputDigest } from "./cache.ts";
import { EntryId } from "./corpus.ts";

const parts = {
  transport: "workers-ai",
  classifier: "jev",
  model: "typesafe/jev",
  rulesVersion: 1,
  entryId: EntryId.make("bb-spam-001"),
  inputDigest: "abc",
} as const;

layer(Layer.mergeAll(NodeServices.layer, Digest.layerWebCrypto))((it) => {
  it.effect("keys a result by transport, classifier, model, rules version, entry and input", () =>
    Effect.gen(function* () {
      const keys = new Set([
        cacheKey(parts),
        cacheKey({ ...parts, transport: "dry" }),
        cacheKey({ ...parts, classifier: "openai" }),
        cacheKey({ ...parts, model: "typesafe/jev-1.14.0" }),
        cacheKey({ ...parts, rulesVersion: 2 }),
        cacheKey({ ...parts, entryId: EntryId.make("bb-spam-002") }),
        cacheKey({ ...parts, inputDigest: "abd" }),
      ]);
      assert.strictEqual(keys.size, 7);
      assert.strictEqual(cacheKey({ ...parts }), cacheKey(parts));

      const fields = { name: "R", content: "Salve" };
      const digest = yield* inputDigest(fields, "Pottery classes");
      const sameInput = yield* inputDigest({ ...fields }, "Pottery classes");
      const otherField = yield* inputDigest({ ...fields, content: "Salve!" }, "Pottery classes");
      const otherContext = yield* inputDigest(fields, "");
      assert.strictEqual(sameInput, digest);
      assert.notStrictEqual(otherField, digest);
      assert.notStrictEqual(otherContext, digest);
    }),
  );

  it.effect("reads back the results of an earlier run and skips a truncated line", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const call = { scores: { model: "jev-1.13.0", spam: 0.9 }, latencyMs: 412 };

      const first = yield* Layer.build(fileCache(directory));
      yield* ResultCache.use((cache) => cache.put("a", call)).pipe(Effect.provideContext(first));
      yield* fs.writeFileString(path.join(directory, "cache.jsonl"), '{"key":"b","call":{"sco', {
        flag: "a",
      });

      const second = yield* Layer.build(fileCache(directory));
      const [a, b] = yield* ResultCache.use((cache) =>
        Effect.all([cache.get("a"), cache.get("b")]),
      ).pipe(Effect.provideContext(second));
      assert.deepEqual(a, Option.some(call));
      assert.isTrue(Option.isNone(b));
    }),
  );
});
