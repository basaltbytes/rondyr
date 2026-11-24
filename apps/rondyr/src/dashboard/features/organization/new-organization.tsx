import { useMutation } from "@tanstack/react-query";
import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { FormProblem, TextAreaField, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { createOrganizationMutation } from "~/lib/api/organizations";
import { statusOf } from "~/lib/api/request";

type CreateProblem = "forbidden" | "failed";

interface NewOrganizationProps {
  /** Opens the new organization, once the organizations are read again. */
  readonly onCreated: () => Promise<void>;
}

/** Creates an organization and its first form. */
export function NewOrganization({ onCreated }: NewOrganizationProps) {
  const { t } = useTranslation();
  const { mutateAsync: create } = useMutation(createOrganizationMutation);
  const [problem, action, pending] = useActionState(
    async (_: CreateProblem | null, form: FormData): Promise<CreateProblem | null> => {
      try {
        await create(form);
        await onCreated();
        return null;
      } catch (cause) {
        return statusOf(cause) === 403 ? "forbidden" : "failed";
      }
    },
    null,
  );
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
          <FormProblem>
            {problem === "forbidden"
              ? t("inbox.setup.forbidden")
              : problem === "failed"
                ? t("inbox.setup.failed")
                : null}
          </FormProblem>
          <Button type="submit" variant="default" className="justify-self-start" disabled={pending}>
            {pending ? t("inbox.setup.pending") : t("inbox.setup.submit")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
