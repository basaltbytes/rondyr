import { useTranslation } from "react-i18next";

/** Holds the place of a page while its code and its data load. */
export function PagePending() {
  const { t } = useTranslation();
  return <output className="block p-6 text-sm text-muted-foreground">{t("common.loading")}</output>;
}
