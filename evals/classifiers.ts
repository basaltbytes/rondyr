import { ClassifierProvider } from "../src/adapters/ai/classifier.ts";
import { scoreWithJev } from "../src/adapters/ai/jev.ts";
import { scoreWithOpenAi } from "../src/adapters/ai/openai-decisions.ts";

/** The values of `RONDYR_CLASSIFIER`. */
export const ClassifierName = ClassifierProvider;

export type ClassifierName = typeof ClassifierProvider.Type;

/** USD per million tokens, from the model pages of the Cloudflare documentation. */
export interface Prices {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
  readonly source: string;
  readonly checkedOn: string;
}

interface Classifier {
  /** The model that the adapter passes to `run`. The runner stops if the adapter asks for another. */
  readonly model: string;
  readonly score: typeof scoreWithJev | typeof scoreWithOpenAi;
  readonly prices: Prices;
}

/** The classifiers of src/adapters/ai/classifier.ts. */
export const classifiers = {
  jev: {
    model: "typesafe/jev",
    score: scoreWithJev,
    prices: {
      input: 0.042,
      cachedInput: 0,
      output: 0,
      source: "https://developers.cloudflare.com/ai/models/typesafe/jev/",
      checkedOn: "2026-11-20",
    },
  },
  openai: {
    model: "openai/decisions",
    score: scoreWithOpenAi,
    prices: {
      // The page lists no cached input price; the input price is used for cached tokens.
      input: 0.1,
      cachedInput: 0.1,
      output: 0,
      source: "https://developers.cloudflare.com/ai/models/openai/decisions/",
      checkedOn: "2026-11-20",
    },
  },
} as const satisfies { readonly [name in ClassifierName]: Classifier };
