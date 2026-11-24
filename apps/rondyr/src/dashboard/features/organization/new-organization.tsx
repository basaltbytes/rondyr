import { useMutation } from "@tanstack/react-query";
import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { FormProblem, TextAreaField, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { createOrganizationMutation } from "~/lib/api/organizations";

interface NewOrganizationProps {
  /** Opens the new organization, once the organizations are read again. */
  readonly onCreated: () => Promise<void>;
}

/** Creates an organization and its first form. */
export function NewOrganization({ onCreated }: NewOrganizationProps) {
  const { t } = useTranslation();
  const { mutateAsync: create } = useMutation(createOrganizationMutation);
  const [failed, action, pending] = useActionState(async (_: boolean, form: FormData) => {
    try {
      await create(form);
      await onCreated();
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
