import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ProductLogo } from "~/components/product-logo";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";

/**
 * Full-page error screen for the root route boundary. Keeps navigation back to the
 * dashboard and retries both TanStack Query and the router together.
 */
export function RootErrorPage({ reset }: ErrorComponentProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const queryReset = useQueryErrorResetBoundary();

  function retry() {
    queryReset.reset();
    reset();
    void router.invalidate();
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
            className="mb-2 flex size-10 items-center justify-center rounded-full bg-destructive-subtle text-destructive"
          >
            <AlertTriangle className="size-5" />
          </span>
          <CardTitle>{t("errorBoundary.title")}</CardTitle>
          <CardDescription role="alert">{t("errorBoundary.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button variant="default" onClick={retry}>
              <RotateCcw aria-hidden="true" className="size-4" />
              {t("errorBoundary.retry")}
            </Button>
            <Button onClick={() => window.location.reload()}>
              <RefreshCw aria-hidden="true" className="size-4" />
              {t("errorBoundary.reload")}
            </Button>
          </div>
          <Link to="/" className="text-sm font-medium underline underline-offset-4">
            {t("errorBoundary.home")}
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}

/**
 * Route-level error boundary rendered inside the active layout so the sidebar or list
 * stays usable while one view recovers.
 */
export function RouteError({ reset }: ErrorComponentProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const queryReset = useQueryErrorResetBoundary();

  function retry() {
    queryReset.reset();
    reset();
    void router.invalidate();
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 lg:col-span-2">
      <Card className="w-full max-w-md">
        <CardHeader>
          <span
            aria-hidden="true"
            className="mb-2 flex size-10 items-center justify-center rounded-full bg-destructive-subtle text-destructive"
          >
            <AlertTriangle className="size-5" />
          </span>
          <CardTitle>{t("errorBoundary.title")}</CardTitle>
          <CardDescription role="alert">{t("errorBoundary.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button variant="default" onClick={retry}>
              <RotateCcw aria-hidden="true" className="size-4" />
              {t("errorBoundary.retry")}
            </Button>
            <Button onClick={() => window.location.reload()}>
              <RefreshCw aria-hidden="true" className="size-4" />
              {t("errorBoundary.reload")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
