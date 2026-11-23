import { Option } from "effect";
import { useTranslation } from "react-i18next";

import { maxDestinationNameLength } from "@rondyr/deliveries/connectors/connector-target";
import { maxRecipients } from "@rondyr/deliveries/email";

import { FormProblem } from "~/components/text-field";
import { destinationRefusalOf, type TargetRequestError } from "~/lib/api/destinations";

/**
 * Why a request to the destinations API failed: the problem that the API names, or no
 * stated reason.
 */
export type DestinationFailure = TargetRequestError | "unexplained";

/** Run a request to the destinations API and return why it failed, or null. */
export async function attempt(request: () => Promise<void>): Promise<DestinationFailure | null> {
  try {
    await request();
    return null;
  } catch (cause) {
    return Option.getOrElse(destinationRefusalOf(cause), (): DestinationFailure => "unexplained");
  }
}

interface DestinationFailureNoteProps {
  readonly failure: DestinationFailure | null;
  /** The message for a failure that the API does not explain. */
  readonly fallback: string;
  /** The label of a setting of a connector, for a refusal that names one. */
  readonly settingLabel?: (name: string) => string;
}

/** The message of a failed request to the destinations API, next to the fields it is about. */
export function DestinationFailureNote({
  failure,
  fallback,
  settingLabel,
}: DestinationFailureNoteProps) {
  const { t } = useTranslation();

  function explain(problem: TargetRequestError) {
    switch (problem.error) {
      case "destination-refused":
        return t(`inbox.webhooks.refusals.${problem.reason}`);
      case "recipients-refused":
        return t(`inbox.emails.refusals.${problem.reason}`, { max: maxRecipients });
      case "name-refused":
        return t("inbox.connectors.refusals.name", { max: maxDestinationNameLength });
      case "settings-refused":
        return t(`inbox.connectors.refusals.${problem.reason}`, {
          field: settingLabel?.(problem.field) ?? problem.field,
        });
      case "secrets-key-missing":
        return t("inbox.webhooks.missingSecretsKey");
      case "email-provider-missing":
        return t("inbox.emails.missingProvider");
      case "test-limit-unavailable":
        return t("inbox.destinations.test.limitUnavailable");
    }
  }

  if (failure === null) return null;
  return <FormProblem>{failure === "unexplained" ? fallback : explain(failure)}</FormProblem>;
}
