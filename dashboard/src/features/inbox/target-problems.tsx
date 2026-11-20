import { Option, Schema } from "effect";
import { useTranslation } from "react-i18next";

import { maxRecipients } from "@rondyr/deliveries/email";

import { FormProblem } from "~/components/text-field";
import { TargetRequestFailed } from "~/lib/targets-client";
import type { TargetProblem } from "~/lib/targets-client";

const isFailed = Schema.is(TargetRequestFailed);

/** Why a request to the targets API failed: the problem that the API names, or no stated reason. */
export type TargetFailure = TargetProblem | "unexplained";

/** Run a request to the targets API and return why it failed, or null. */
export async function attempt(request: () => Promise<void>): Promise<TargetFailure | null> {
  try {
    await request();
    return null;
  } catch (error) {
    if (!isFailed(error)) return "unexplained";
    return Option.match(error.problem, {
      onNone: (): TargetFailure => "unexplained",
      onSome: (problem): TargetFailure => problem,
    });
  }
}

interface TargetFailureNoteProps {
  readonly failure: TargetFailure | null;
  /** The message for a failure that the API does not explain. */
  readonly fallback: string;
}

/** The message of a failed request to the targets API, next to the fields it is about. */
export function TargetFailureNote({ failure, fallback }: TargetFailureNoteProps) {
  const { t } = useTranslation();

  function explain(problem: TargetProblem) {
    switch (problem.error) {
      case "destination-refused":
        return t(`inbox.webhooks.refusals.${problem.reason}`);
      case "recipients-refused":
        return t(`inbox.emails.refusals.${problem.reason}`, { max: maxRecipients });
      case "secrets-key-missing":
        return t("inbox.webhooks.missingSecretsKey");
      case "email-provider-missing":
        return t("inbox.emails.missingProvider");
    }
  }

  if (failure === null) return null;
  return <FormProblem>{failure === "unexplained" ? fallback : explain(failure)}</FormProblem>;
}
