import { Schema } from "effect";
import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { FormProblem } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { confirmRecipient, TargetRequestFailed } from "~/lib/targets-client";

const isFailed = Schema.is(TargetRequestFailed);

type Outcome = "confirmed" | "invalid" | "failed";

interface RecipientConfirmationProps {
  /** The secret of the link, from the fragment of its URL. */
  readonly token: string;
}

/**
 * The public page of a confirmation link. It names neither the organization
 * nor the form, and it confirms only when the person presses the button: a
 * mail scanner that opens the link confirms nothing.
 */
export function RecipientConfirmation({ token }: RecipientConfirmationProps) {
  const { t } = useTranslation();
  const [outcome, confirm, confirming] = useActionState(async (): Promise<Outcome> => {
    try {
      await confirmRecipient(token);
      return "confirmed";
    } catch (error) {
      return isFailed(error) && error.status === 404 ? "invalid" : "failed";
    }
  }, null);

  if (outcome === "confirmed" || outcome === "invalid") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t(`recipientConfirmation.${outcome}.title`)}</CardTitle>
          <CardDescription>{t(`recipientConfirmation.${outcome}.body`)}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("recipientConfirmation.title")}</CardTitle>
        <CardDescription>{t("recipientConfirmation.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={confirm} className="grid gap-3">
          <FormProblem>
            {outcome === "failed" ? t("recipientConfirmation.failed") : null}
          </FormProblem>
          <Button type="submit" variant="default" disabled={confirming}>
            {confirming
              ? t("recipientConfirmation.confirming")
              : t("recipientConfirmation.confirm")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
