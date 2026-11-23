import { Option } from "effect";
import { useTranslation } from "react-i18next";

import { FormProblem } from "~/components/text-field";
import { formRefusalOf, type FormRequestError } from "~/lib/api/forms";

/** Why a request to the forms API failed: the problem that the API names, or no stated reason. */
export type FormFailure = FormRequestError | "unexplained";

/** Run a request to the forms API and return why it failed, or null. */
export async function attempt(request: () => Promise<void>): Promise<FormFailure | null> {
  try {
    await request();
    return null;
  } catch (cause) {
    return Option.getOrElse(formRefusalOf(cause), (): FormFailure => "unexplained");
  }
}

interface FormFailureNoteProps {
  readonly failure: FormFailure | null;
  /** The message for a failure that the API does not explain. */
  readonly fallback: string;
  /** The ID that a field names in `aria-describedby`. */
  readonly id?: string;
}

/** The message of a failed request to the forms API, next to the field it is about. */
export function FormFailureNote({ failure, fallback, id }: FormFailureNoteProps) {
  const { t } = useTranslation();
  if (failure === null) return null;
  return (
    <div id={id}>
      <FormProblem>
        {failure !== "unexplained" && failure.error === "success-url-refused"
          ? t(`inbox.forms.redirect.refusals.${failure.reason}`)
          : fallback}
      </FormProblem>
    </div>
  );
}
