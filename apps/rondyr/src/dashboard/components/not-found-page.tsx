import { Link } from "@tanstack/react-router";
import { SearchX } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ProductLogo } from "~/components/product-logo";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";

/**
 * An address that matches no page, or the page of an organization that the account is
 * not a member of: both say the same, so an address tells nothing about another account.
 */
export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <main className="mx-auto grid max-w-md gap-5 px-5 py-12 sm:py-16">
      <h1 className="flex justify-center">
        <ProductLogo size="lg" />
      </h1>
      <Card>
        <CardHeader>
          <span
            aria-hidden="true"
            className="mb-2 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <SearchX className="size-5" />
          </span>
          <CardTitle>{t("notFound.title")}</CardTitle>
          <CardDescription>{t("notFound.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link to="/" className="text-sm font-medium underline underline-offset-4">
            {t("notFound.messages")}
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
