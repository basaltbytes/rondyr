# Classifier evaluation

`pnpm evaluate` replays a labeled corpus as the submission history of one organization. It uses the Worker's repetition rules and builds the same input for Jev and OpenAI Decisions. It runs in Node, calls the adapters with the gateway options of `apps/rondyr/src/worker/adapters/ai/gateway.ts` for occurrences below the repetition thresholds, then applies `reviewReason` to their scores.

The runner and the Worker read their default policies from `apps/rondyr/src/domain/submissions/classification-policy.ts`. The initial evaluation on real submissions is recorded in [#31](https://github.com/basaltbytes/rondyr/issues/31), and [#40](https://github.com/basaltbytes/rondyr/issues/40) records the measurement behind the solicitation threshold. [Architecture section 5](../architecture.md#5-intelligent-classification) describes the current defaults.

The harness isn't part of the Worker: nothing in `apps/rondyr/src/` imports `apps/rondyr/evals/`, and `pnpm deploy:dry` checks the bundle size as before.

`pnpm evaluate` runs in `apps/rondyr/`, even when you start it from the repository root. The paths it takes, the corpus, `--policy` and `--out`, are relative to that folder, so the commands on this page write `evals/corpus/synthetic.jsonl` for `apps/rondyr/evals/corpus/synthetic.jsonl`.

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

The business context of the form is in a second file next to the corpus. For `apps/rondyr/evals/corpus/synthetic.jsonl`, use `apps/rondyr/evals/corpus/synthetic.context.txt`. The harness and the Worker both trim the context and keep as many whole characters as fit within 2,000 UTF-16 code units. An empty file means the form has no business context. Both classifiers ask about spam and unsolicited sales outreach on every call. They ask about business relevance only when the context is present.

A separate file keeps the corpus lines in the shape the issue describes, so an existing corpus works once the context file is next to it. A command-line option would let two runs of the same corpus use different contexts, and the results would no longer be comparable; the file is versioned, or kept local, together with its corpus. The context is part of the cache key, so changing it scores every entry again.

### Organization domains

Declare domains in an optional `<name>.domains.txt` next to the corpus. Use one lowercase ASCII hostname per line, up to ten distinct domains. Blank lines are ignored. A missing or empty file means the organization has no declared domains.

The replay checks the submission's `email` field against the declared domains and their subdomains. On a match, both classifiers receive `sender_matches_organization_domain: true` and a blank email field. Otherwise the fact is left out, so a message from any other sender gets the same input as with no declared domains.

### Synthetic corpus

`apps/rondyr/evals/corpus/synthetic.jsonl` contains 60 lines for a fictional pottery workshop in Lyon, including a series from one sender, a series with the same content, and a legitimate double submission. The organization declares `atelier-terre.example`. Promotions and messages from colleagues use that domain and its subdomains. Unsolicited SEO, lead generation, and subcontracting offers use the `spam` label, as does a message that asks who handles the workshop's social media so the sender can send them an idea. A quote request, a delivery question from an existing supplier, a proposal from a peer, a shop that wants to resell the workshop's pieces, and a podcast recording request use the `legitimate` label; the last two read a little like a pitch, which makes them the boundary cases of the solicitation question. People appear by first name only, and every address and link uses the reserved `.example` domain.

It's small: a result on it says whether the pipeline works and gives a first idea, not a measure of the classifiers.

### Local corpora

Real submissions stay out of git. Put a real corpus and its sidecars in `apps/rondyr/evals/corpus/local/`:

```text
apps/rondyr/evals/corpus/local/basaltbytes.jsonl
apps/rondyr/evals/corpus/local/basaltbytes.context.txt
apps/rondyr/evals/corpus/local/basaltbytes.domains.txt
```

`.gitignore` excludes everything in `apps/rondyr/evals/corpus/` except the three synthetic files. Check `git status` before committing.

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
| `--escalation` | off | Compare decisions with escalation using cached scores only |
| `--policy` | classifier defaults | JSON file with the full policy to apply to every selected classifier |
| `--out` | `evals/out` | Directory for the cache and the reports, ignored by git |
| `--dry` | off | Fake scores, no credentials |

### Comparing policies

Run once with the defaults. To replay those scores with a different policy, pass a JSON file such as `policy.json`.

```json
{
  "thresholds": {
    "probableSpam": 0.7,
    "ambiguous": 0.3,
    "solicitation": 0.5,
    "lowRelevance": 0.35
  },
  "offTopic": "accept"
}
```

```sh
pnpm evaluate --classifier both evals/corpus/synthetic.jsonl
pnpm evaluate --classifier both --policy policy.json evals/corpus/synthetic.jsonl
```

Keep the same output directory and omit `--refresh` to reuse the cached scores. The runner calls Workers AI for inputs without a cached score, including failed calls from the first run. Save a copy of the first report before the second command, which writes to the same report paths. Set `offTopic` to `review` to quarantine for low relevance or to `accept` to accept those messages with the `off-topic` label. Spam and sales outreach still take priority.

### Comparing escalation

```sh
pnpm evaluate --escalation evals/corpus/synthetic.jsonl
pnpm evaluate --escalation --classifier jev --policy policy.json evals/corpus/synthetic.jsonl
```

Use an output directory from a previous run with both classifiers. By default the report compares both directions. Select `--classifier jev` or `--classifier openai` to choose the primary model. The mode simulates an organization that has enabled escalation, and it applies `escalatedDecision` from `apps/rondyr/src/domain/submissions/classification.ts`, the function the Worker uses.

The second model only settles the spam doubt. It uses its default thresholds with the primary policy's off-topic choice, and any reason it finds keeps the submission ambiguous. When it finds nothing, the primary model's solicitation and low relevance rules still apply to the primary scores, so a submission can end up in quarantine as `solicitation` or `low-relevance`. An accepted submission gets the off-topic label when either model finds it off-topic.

The replay reads cached scores without credentials or new calls, and rejects `--refresh`. With `--dry`, it reads previously cached fake scores. For each expected label, the `.escalation.json` and `.escalation.md` reports count the final decision of every submission that the primary model left ambiguous: accepted, accepted with the off-topic label, still ambiguous, quarantined for solicitation, or quarantined for low relevance. A missing second score leaves the submission ambiguous and has its own column. A missing primary score leaves the original decision unknown.

### Calls

Each call is `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run` with `{ "model": …, "input": … }`, where the model and the input are exactly what the adapter passes to `env.AI.run`. The `gateway` options of the binding become the headers that the [REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) documents: `id` is `cf-aig-gateway-id`, `collectLog` is `cf-aig-collect-log`, and `skipCache` is `cf-aig-skip-cache`. If `gateway.ts` gains an option without a known header, the run stops instead of dropping it. The harness accepts the answer whether or not it's wrapped in the Cloudflare API envelope (`{ success, result }`).

A call has 12 seconds, as in the Worker. A failure that the adapter marks retryable, such as a network error, an HTTP error or a timeout, is tried again after 10 then 30 seconds, for three calls in total, like the saga. An answer that the adapter refuses isn't tried again. A `401` or `403` stops the run, because every other call would fail the same way.

### Cache

Each scored call is appended to `apps/rondyr/evals/out/cache.jsonl` as soon as it returns, so an interrupted run can resume. The key is the transport (`workers-ai` or `dry`), the classifier, the requested model, the scoring version, the line ID and a SHA-256 of the full classifier input. Editing an earlier submission can change the facts and invalidate later cache entries. Policy changes preserve cached scores. Failures aren't cached.

The model name in the key is the one the adapter requests, such as `typesafe/jev`. The model that answers can change behind that name. The report lists the models that answered, and `--refresh` scores everything with the current one. Advance the scoring version in `apps/rondyr/evals/evaluate.ts` when a change to the adapters or model questions invalidates existing scores.

## Report

The terminal shows the summary. The full report, with the threshold sweep, is written to `apps/rondyr/evals/out/<corpus>.report.json` and `apps/rondyr/evals/out/<corpus>.report.md` (`.dry.report.*` for a dry run). Both contain ids, labels, families, scores and decisions, and never a field value, a note or the business context.

For each classifier, in this order:

- **Legitimate messages quarantined.** The total includes intake rules and failed calls. The table lists the rule decisions by id and score, and the failed calls appear below.
- **Off-topic messages quarantined.** Genuine messages that a person has to read and archive. The report also lists messages accepted with the off-topic label.
- **Spam accepted**, by id and family.
- **Expected label and decision.** The table includes `solicitation` and `repetition`. Each cell counts distinct corpus lines and the submissions those lines represent. A line can appear in more than one cell when its occurrences get different decisions. The decision list identifies the first occurrence and number of submissions in each result.
- **Quarantine of spam.** Spam is the positive class; legitimate and off-topic lines are the negatives; ambiguous lines and failed calls are left out. Precision is the share of quarantined lines that are spam, and recall the share of spam that is quarantined, for any reason. Both are given for lines and for submissions.
- **Latency**: p50, p90, p95, p99 and max of the scored calls, in milliseconds, from the client. Results from the cache keep the latency of the run that recorded them.
- **Cost**: the token usage of the answers times the per-million prices of the model pages, checked on 2026-11-20 and kept in `apps/rondyr/evals/classifiers.ts`. If an answer has no usage, the cost is reported as unavailable. Calls that failed may also be billed and aren't counted.
- **Failed calls**, with the number of calls, whether the failure was retryable and the last error: an HTTP status with the Cloudflare error codes, a timeout, or an answer the adapter refused. Error messages from Cloudflare aren't kept, since they can repeat the request.

The report also gives the returned model ids and their counts, `rulesVersion`, the policy applied to each classifier, and the gateway options.

### Threshold sweep

The sweep uses `reviewReason` to recompute decisions from the recorded scores. It tests both spam thresholds together, holding the other settings fixed, and varies the relevance threshold and the solicitation threshold separately. The grid runs from 0 to 1 in steps of 0.05 and includes the policy's active thresholds. It also compares `review` with `accept` for off-topic messages. Intake quarantines and failed calls count the same at every point.

Read the `legitimate` quarantined count first, then compare how many spam submissions are accepted at points with zero legitimate quarantines. Each point also counts off-topic quarantines and decisions with the `probable-spam` or `solicitation` reason. The Markdown has a table for each setting and the JSON contains all points.

The Worker quarantines a message whose solicitation score is above 0.50. On 20 November 2026, with Jev, no `legitimate` or `off-topic` line of the synthetic corpus scored above 0.32 and the four `syn-solicitation-*` lines scored between 0.94 and 0.98. OpenAI Decisions kept every `legitimate` line at 0.04 or below and scored the same four lines between 0.96 and 1. Scores vary by a few hundredths from one run to the next. When you change the solicitation question or its threshold, run both classifiers on the same corpus before and after the change, and use the full report to check that every `legitimate` entry stays out of quarantine, including entries quarantined at intake or after a failed call.

By default, the Worker quarantines a message whose relevance is below 0.50 with Jev or below 0.45 with OpenAI Decisions; until rules version 6, both classifiers used 0.35. On 21 November 2026, each classifier ran three times on the synthetic corpus and on the maintainer's corpus of real submissions. With Jev, the move from 0.35 to 0.50 quarantined no `legitimate` line on either corpus, and the spam lines accepted went from 5 to 3 on the synthetic corpus and from 7 to 5 on the real one. Across the three runs, the lowest relevance of a `legitimate` line was 0.60 on the synthetic corpus and 0.66 on the real one. With OpenAI Decisions, the move from 0.35 to 0.45 also quarantined no `legitimate` line; the spam lines accepted went from 4 to 2 on the synthetic corpus and stayed at 3 on the real one. Its scores were identical in all three runs, and the lowest `legitimate` relevance was 0.50 on the synthetic corpus, 0.05 above the threshold, and 0.87 on the real one.

## Privacy

- A real run sends each message to Workers AI, and through it to the model provider: TypeSafe for Jev, OpenAI for Decisions. Only run a real corpus if the people who sent those messages would expect them to go to these providers, as they do in production.
- The gateway options of the Worker turn off logging and the cache of AI Gateway for each call (`cf-aig-collect-log: false`, `cf-aig-skip-cache: true`), so the messages don't appear in the gateway logs.
- The cache and the reports contain no message content. The cache holds a SHA-256 of each input, which can confirm a guess about a short message; keep `apps/rondyr/evals/out/` local, as `.gitignore` does.
- The local corpus is the sensitive file. Keep it in `apps/rondyr/evals/corpus/local/`, and don't paste its lines into issues or pull requests.

## Tests

`pnpm check` runs the harness tests in Node, as the `evals` Vitest project, without network: corpus validation with invalid lines, the decisions at each threshold, the report counts with `duplicates`, the cache key, the REST request against a fake Cloudflare API, retries, and a dry run of the synthetic corpus that checks that no field value appears in the reports.
