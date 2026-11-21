import {
  type ClassifierInput,
  classifierInput,
  isRepetition,
  repetitionKeys,
  repetitionWindowMs,
} from "../src/domain/submissions/classifier-input.ts";
import { type Corpus, type CorpusEntry, weight } from "./corpus.ts";

interface EvaluationInput {
  readonly entry: CorpusEntry;
  readonly firstOccurrence: number;
  readonly input: ClassifierInput | null;
}

/** An indexed 30-day history; a line with duplicates adds one weighted bucket. */
function history() {
  const series = new Map<
    string,
    {
      readonly buckets: Array<{ readonly time: number; readonly size: number }>;
      oldest: number;
      total: number;
    }
  >();
  return (key: string | null, time: number, size: number) => {
    if (key === null) return 0;
    const previous = series.get(key);
    if (previous === undefined) {
      series.set(key, { buckets: [{ time, size }], oldest: 0, total: size });
      return 0;
    }
    const oldest = time - repetitionWindowMs;
    for (
      let bucket = previous.buckets[previous.oldest];
      bucket && bucket.time < oldest;
      bucket = previous.buckets[previous.oldest]
    ) {
      previous.oldest += 1;
      previous.total -= bucket.size;
    }
    const count = previous.total;
    previous.buckets.push({ time, size });
    previous.total += size;
    return count;
  };
}

export function replay(corpus: Corpus): readonly EvaluationInput[] {
  const inputs: EvaluationInput[] = [];
  const dated = { sender: history(), content: history() };
  const undated = { sender: history(), content: history() };
  const ordered = corpus.entries.toSorted((a, b) =>
    (a.received ?? "").localeCompare(b.received ?? ""),
  );
  for (const entry of ordered) {
    const keys = repetitionKeys(entry.fields);
    const timeline = entry.received === undefined ? undated : dated;
    const time = entry.received === undefined ? 0 : Date.parse(entry.received);
    const size = weight(entry);
    const priorSender = timeline.sender(keys.sender, time, size);
    const priorContent = timeline.content(keys.content, time, size);
    for (let offset = 0; offset < size;) {
      const counts = {
        prior_same_sender: keys.sender === null ? 0 : priorSender + offset,
        prior_same_content: keys.content === null ? 0 : priorContent + offset,
      };
      const repeated = isRepetition(counts);
      // Without a key, all occurrences have the same facts. After the threshold,
      // all remaining occurrences have the same decision without a model call.
      const groupSize =
        repeated || (keys.sender === null && keys.content === null) ? size - offset : 1;
      inputs.push({
        entry: groupSize === size ? entry : { ...entry, duplicates: groupSize },
        firstOccurrence: offset + 1,
        input: repeated
          ? null
          : classifierInput(entry.fields, corpus.context, counts, corpus.domains),
      });
      offset += groupSize;
    }
  }
  return inputs;
}
