import { FileWarning, RefreshCw, ServerCrash, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ProductLogo } from "~/components/product-logo";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";

/**
 * Why the organizations of the account could not be read: the server did not
 * answer, it answered with an error status, or its answer is not one that this
 * version of the dashboard reads.
 */
export type LoadFailure = "unreachable" | "unreadable" | { readonly status: number };

interface OrganizationsUnavailableProps {
  readonly failure: LoadFailure;
  readonly onRetry: () => void;
  /** The account and its sign-out button: this screen has no sidebar. */
  readonly signOut: ReactNode;
}

/** The screen shown in place of the dashboard when its organizations cannot be read. */
export function OrganizationsUnavailable({
  failure,
  onRetry,
  signOut,
}: OrganizationsUnavailableProps) {
  const { t } = useTranslation();
  const Icon =
    failure === "unreachable" ? WifiOff : failure === "unreadable" ? FileWarning : ServerCrash;

  function explain() {
    if (failure === "unreachable") return t("inbox.organizations.unavailable.unreachable");
    if (failure === "unreadable") return t("inbox.organizations.unavailable.unreadable");
    if (failure.status === 401) return t("inbox.organizations.unavailable.signedOut");
    return t("inbox.organizations.unavailable.status", { status: failure.status });
  }

  return (
    <main className="mx-auto grid max-w-md gap-5 px-5 py-12 sm:py-16">
      <h1 className="flex justify-center">
        <ProductLogo size="lg" />
      </h1>
      <Card>
        <CardHeader>
          <span
            aria-hidden="true"
            className="mb-2 flex size-10 items-center justify-center rounded-full bg-warning-subtle text-warning"
          >
            <Icon className="size-5" />
          </span>
          <CardTitle>{t("inbox.organizations.unavailable.title")}</CardTitle>
          <CardDescription role="alert">{explain()}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="default" className="justify-self-start" onClick={onRetry}>
            <RefreshCw aria-hidden="true" className="size-4" />
            {t("inbox.organizations.unavailable.retry")}
          </Button>
        </CardContent>
      </Card>
      {signOut}
    </main>
  );
}
