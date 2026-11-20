import { Option, Schema } from "effect";

import { TargetRequestFailed } from "~/lib/targets-client";
import type { TargetProblem } from "~/lib/targets-client";

import {
  destinationRefusals,
  missingEmailProvider,
  missingSecretsKey,
  recipientRefusals,
} from "./strings.ts";

const isFailed = Schema.is(TargetRequestFailed);

function explain(problem: TargetProblem) {
  switch (problem.error) {
    case "destination-refused":
      return destinationRefusals[problem.reason];
    case "recipients-refused":
      return recipientRefusals[problem.reason];
    case "secrets-key-missing":
      return missingSecretsKey;
    case "email-provider-missing":
      return missingEmailProvider;
  }
}

/** Run a request to the targets API and return the message to show if it fails, or null. */
export async function attempt(request: () => Promise<void>, fallback: string) {
  try {
    await request();
    return null;
  } catch (error) {
    if (!isFailed(error)) return fallback;
    return Option.match(error.problem, { onNone: () => fallback, onSome: explain });
  }
}
