import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { FormProblem, TextAreaField, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { createInbox } from "~/lib/inbox-client";

interface InboxSetupProps {
  readonly onCreated: () => void;
}

/** Creates an organization and its first form. */
export function InboxSetup({ onCreated }: InboxSetupProps) {
  const { t } = useTranslation();
  const [failed, action, pending] = useActionState(async (_: boolean, form: FormData) => {
    try {
      await createInbox(form);
      onCreated();
      return false;
    } catch {
      return true;
    }
  }, false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("inbox.sections.organization")}</CardTitle>
        <CardDescription>{t("inbox.setup.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4">
          <TextField
            label={t("inbox.setup.organization")}
            name="organizationName"
            required
            maxLength={100}
          />
          <TextField
            label={t("inbox.setup.firstForm")}
            name="formName"
            required
            maxLength={100}
            placeholder={t("inbox.setup.firstFormPlaceholder")}
          />
          <TextAreaField
            label={t("inbox.business.label")}
            name="businessContext"
            maxLength={2000}
            hint={t("inbox.business.hint")}
          />
          <FormProblem>{failed ? t("inbox.setup.failed") : null}</FormProblem>
          <Button type="submit" variant="default" className="justify-self-start" disabled={pending}>
            {pending ? t("inbox.setup.pending") : t("inbox.setup.submit")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
