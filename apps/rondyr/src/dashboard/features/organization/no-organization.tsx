import { useTranslation } from "react-i18next";

import { Card, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";

/**
 * Shown in place of the creation form to an account that belongs to no organization
 * on an instance that already has some: only an invitation can let it in.
 */
export function NoOrganization() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("inbox.noOrganization.title")}</CardTitle>
        <CardDescription>{t("inbox.noOrganization.description")}</CardDescription>
      </CardHeader>
    </Card>
  );
}
