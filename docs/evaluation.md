# Classifier evaluation

`pnpm evaluate` replays a labeled corpus as the submission history of one organization. It uses the Worker's repetition rules and builds the same input for Jev and OpenAI Decisions. It runs in Node, calls the adapters with the gateway options of `src/adapters/ai/gateway.ts` for occurrences below the repetition thresholds, then applies `reviewReason` to their scores.

The initial evaluation on real submissions is recorded in [#31](https://github.com/basaltbytes/rondyr/issues/31). The model score thresholds still come from the first estimate described in [architecture.md](../architecture.md#5-classification-intelligente). Issue [#6](https://github.com/basaltbytes/rondyr/issues/6) tracks thresholds per classifier.

The harness isn't part of the Worker: nothing in `src/` imports `evals/`, and `pnpm deploy:dry` checks the bundle size as before.

## Corpus format

A corpus is a JSON Lines file: one submission per line, blank lines ignored.

```json
{"id":"syn-spam-005","label":"spam","family":"price-probe","duplicates":2,"note":"Latin.","fields":{"name":"Robertvaf","email":"robert@probe.example","content":"Salve, scire volui pretium tuum."}}
```

| Key | Required | Value |
| --- | --- | --- |
| `id` | Yes | Unique in the file. Letters, digits, `.`, `_` and `-`, up to 100 characters, such as `bb-spam-001`. |
| `label` | Yes | `legitimate`, `spam`, `ambiguous` or `off-topic`. |
| `family` | No | A kebab-case group, such as `price-probe` or `lead-gen-callback`, to read the misses by kind. |
| `duplicates` | No | How many identical submissions arrived on the line's date. Defaults to 1. Each occurrence counts towards the history of the next. |
| `note` | No | Free text for whoever edits the corpus. Reports never include it. |
| `source` | No | Where the submission came from. Reports never include it. |
| `received` | No | The day it was received, as `YYYY-MM-DD`. |
| `fields` | Yes | The fields a form would send, with the limits of the Worker: 1 to 32 text fields of at most 4,000 characters. |

`off-topic` is a genuine message that has nothing to do with the business, such as "I found your keys outside your workshop". `ambiguous` is a message where a person could go either way, such as a supplier offering samples to a pottery workshop; the report shows how these are decided, and leaves them out of precision and recall.

Any other key is an error, so a typo such as `familly` doesn't go unnoticed. The loader checks every line and lists each invalid one with its line number and the failing key, without the value.

Dated lines are replayed by `received`, with ties resolved by file order. Undated lines share a separate history in file order, without date expiration. When the dates of duplicate submissions span several days, record them as separate lines so the 30-day window applies to each date.

### Business context

The business context of the form is in a second file next to the corpus. For `evals/corpus/synthetic.jsonl`, use `evals/corpus/synthetic.context.txt`. The harness and the Worker both trim the context and keep as many whole characters as fit within 2,000 UTF-16 code units. An empty file means the form has no business context. The classifiers then score spam only, and no message can be quarantined for low relevance.

A separate file keeps the corpus lines in the shape the issue describes, so an existing corpus works once the context file is next to it. A command-line option would let two runs of the same corpus use different contexts, and the results would no longer be comparable; the file is versioned, or kept local, together with its corpus. The context is part of the cache key, so changing it scores every entry again.

### Organization domains

Declare domains in an optional `<name>.domains.txt` next to the corpus. Use one lowercase ASCII hostname per line, up to ten distinct domains. Blank lines are ignored. A missing or empty file means the organization has no declared domains.

The replay checks the submission's `email` field against the declared domains and their subdomains. On a match, both classifiers receive `sender_matches_organization_domain: true` and a blank email field. Otherwise the fact is left out, so a message from any other sender gets the same input as with no declared domains.

### Synthetic corpus

`evals/corpus/synthetic.jsonl` contains 51 lines for a fictional pottery workshop in Lyon, including a series from one sender, a series with the same content, and a legitimate double submission. The organization declares `atelier-terre.example`. Promotions and messages from colleagues use that domain and its subdomains. People appear by first name only, and every address and link uses the reserved `.example` domain.

It's small: a result on it says whether the pipeline works and gives a first idea, not a measure of the classifiers.

### Local corpora

Real submissions stay out of git. Put a real corpus and its sidecars in `evals/corpus/local/`:

```text
evals/corpus/local/basaltbytes.jsonl
evals/corpus/local/basaltbytes.context.txt
evals/corpus/local/basaltbytes.domains.txt
```

`.gitignore` excludes everything in `evals/corpus/` except the three synthetic files. Check `git status` before committing.

## Running

Without credentials, `--dry` replaces Workers AI with fake scores derived from a hash of each input. The report is marked as a dry run; it checks the corpus, the pipeline and the report format, and measures nothing.

```sh
pnpm evaluate --dry evals/corpus/synthetic.jsonl
```

A real run needs two environment variables:

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | The 32-character id of the account that runs Rondyr. |
| `CLOUDFLARE_API_TOKEN` | An account API token with **Account > Workers AI > Read**. A token with only AI Gateway permissions gets `401`. |

Create a separate token for evaluations rather than reusing the deployment token, which has far more permissions. The harness never prints either value.

```sh
export CLOUDFLARE_ACCOUNT_ID=…
export CLOUDFLARE_API_TOKEN=…
pnpm evaluate --limit 1 --refresh evals/corpus/synthetic.jsonl
pnpm evaluate evals/corpus/synthetic.jsonl
pnpm evaluate --classifier jev evals/corpus/local/basaltbytes.jsonl
```

The first command calls each classifier once and is the quickest check that the token, the endpoint and the answers work. Options come before the corpus path:

| Option | Default | Effect |
| --- | --- | --- |
| `--classifier` | `both` | `jev`, `openai` or `both`, the values of `RONDYR_CLASSIFIER` |
| `--concurrency` | 4 | Calls in flight at once, from 1 to 16 |
| `--limit` | none | Evaluate only the first N lines |
| `--refresh` | off | Call the model again even when the cache has a result |
| `--out` | `evals/out` | Directory for the cache and the reports, ignored by git |
| `--dry` | off | Fake scores, no credentials |

### Calls

Each call is `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run` with `{ "model": …, "input": … }`, where the model and the input are exactly what the adapter passes to `env.AI.run`. The `gateway` options of the binding become the headers that the [REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) documents: `id` is `cf-aig-gateway-id`, `collectLog` is `cf-aig-collect-log`, and `skipCache` is `cf-aig-skip-cache`. If `gateway.ts` gains an option without a known header, the run stops instead of dropping it. The harness accepts the answer whether or not it's wrapped in the Cloudflare API envelope (`{ success, result }`).

A call has 12 seconds, as in the Worker. A failure that the adapter marks retryable, such as a network error, an HTTP error or a timeout, is tried again after 10 then 30 seconds, for three calls in total, like the saga. An answer that the adapter refuses isn't tried again. A `401` or `403` stops the run, because every other call would fail the same way.

### Cache

Each scored call is appended to `evals/out/cache.jsonl` as soon as it returns, so an interrupted run can resume. The key is the transport (`workers-ai` or `dry`), the classifier, the requested model, `rulesVersion`, the line ID and a SHA-256 of the full classifier input. Editing an earlier submission can change the facts and invalidate later cache entries. Failures aren't cached.

The model name in the key is the one the adapter requests, such as `typesafe/jev`. The model that answers can change behind that name (`jev-1.13.0`, then a later version); the report lists the models that answered, and `--refresh` scores everything with the current one.

## Report

The terminal shows the summary. The full report, with the threshold sweep, is written to `evals/out/<corpus>.report.json` and `evals/out/<corpus>.report.md` (`.dry.report.*` for a dry run). Both contain ids, labels, families, scores and decisions, and never a field value, a note or the business context.

For each classifier, in this order:

- **Legitimate messages quarantined.** The false positives, by id, with the reason and the scores. A real message in quarantine waits for someone to find it, which is the failure that matters most.
- **Off-topic messages quarantined.** Genuine messages that a person has to read and archive. Today's rules quarantine them for low relevance on purpose; a spam reason is the worse outcome.
- **Spam accepted**, by id and family.
- **Expected label and decision.** The table includes `repetition` for submissions in quarantine before a model call. Each cell counts distinct corpus lines and the submissions those lines represent. A line can appear in more than one cell when its occurrences get different decisions. The decision list identifies the first occurrence and number of submissions in each result.
- **Quarantine of spam.** Spam is the positive class; legitimate and off-topic lines are the negatives; ambiguous lines and failed calls are left out. Precision is the share of quarantined lines that are spam, and recall the share of spam that is quarantined, for any reason. Both are given for lines and for submissions.
- **Latency**: p50, p90, p95, p99 and max of the scored calls, in milliseconds, from the client. Results from the cache keep the latency of the run that recorded them.
- **Cost**: the token usage of the answers times the per-million prices of the model pages, checked on 2026-11-20 and kept in `evals/classifiers.ts`. If an answer has no usage, the cost is reported as unavailable. Calls that failed may also be billed and aren't counted.
- **Failed calls**, with the number of calls, whether the failure was retryable and the last error: an HTTP status with the Cloudflare error codes, a timeout, or an answer the adapter refused. Error messages from Cloudflare aren't kept, since they can repeat the request.

The report also gives the returned model ids and their counts, `rulesVersion`, the thresholds, and the gateway options.

### Threshold sweep

The sweep recomputes decisions from the recorded scores without new calls. It excludes intake quarantines and failed calls. The JSON has every point of the grid from 0.05 to 0.95 in steps of 0.05 for the two spam thresholds (with the probable-spam threshold at or above the ambiguous one), and for the low relevance threshold with the spam thresholds at 0.70 and 0.30. Each point gives the legitimate and off-topic lines quarantined, the spam accepted, and the legitimate and spam lines that would get `probable-spam`.

The Markdown shows the same grid as three tables. Whether a message is accepted depends only on the lower spam threshold, called `ambiguous`; the `probable-spam` reason depends only on the upper one.

## Privacy

- A real run sends each message to Workers AI, and through it to the model provider: TypeSafe for Jev, OpenAI for Decisions. Only run a real corpus if the people who sent those messages would expect them to go to these providers, as they do in production.
- The gateway options of the Worker turn off logging and the cache of AI Gateway for each call (`cf-aig-collect-log: false`, `cf-aig-skip-cache: true`), so the messages don't appear in the gateway logs.
- The cache and the reports contain no message content. The cache holds a SHA-256 of each input, which can confirm a guess about a short message; keep `evals/out/` local, as `.gitignore` does.
- The local corpus is the sensitive file. Keep it in `evals/corpus/local/`, and don't paste its lines into issues or pull requests.

## Tests

`pnpm check` runs the harness tests in Node, as the `evals` Vitest project, without network: corpus validation with invalid lines, the decisions at each threshold, a comparison of the sweep rules with `reviewReason`, the report counts with `duplicates`, the cache key, the REST request against a fake Cloudflare API, retries, and a dry run of the synthetic corpus that checks that no field value appears in the reports. The REST path has not been checked against the live API yet.
