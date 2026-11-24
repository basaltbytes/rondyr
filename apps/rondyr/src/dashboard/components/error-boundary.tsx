import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ProductLogo } from "~/components/product-logo";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";

interface ErrorBoundaryProps {
  /** Full-page fallback for the root boundary, or a compact fallback for one section. */
  readonly variant?: "page" | "section";
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly failed: boolean;
}

/** Full-page fallback rendered when an unexpected render error reaches the app boundary. */
function AppErrorFallback({ onRetry }: { readonly onRetry: () => void }) {
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
            className="mb-2 flex size-10 items-center justify-center rounded-full bg-destructive-subtle text-destructive"
          >
            <AlertTriangle className="size-5" />
          </span>
          <CardTitle>{t("errorBoundary.title")}</CardTitle>
          <CardDescription role="alert">{t("errorBoundary.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button variant="default" onClick={onRetry}>
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
    </main>
  );
}

/** Compact fallback for an isolated section inside a larger screen. */
function SectionErrorFallback({ onRetry }: { readonly onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="grid justify-items-start gap-2 hairline-t pt-4">
      <p className="text-sm font-medium text-destructive">{t("errorBoundary.sectionTitle")}</p>
      <p className="max-w-prose text-xs text-pretty text-muted-foreground">
        {t("errorBoundary.sectionDescription")}
      </p>
      <Button size="sm" onClick={onRetry}>
        <RotateCcw aria-hidden="true" className="size-3.5" />
        {t("errorBoundary.retry")}
      </Button>
    </div>
  );
}

/** Catches unexpected React render errors so one crash never turns into a blank screen. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(_error: Error): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Error is contained in the boundary state; nothing is logged with message content.
  }

  reset = () => {
    this.setState({ failed: false });
  };

  override render() {
    if (this.state.failed) {
      return this.props.variant === "section" ? (
        <SectionErrorFallback onRetry={this.reset} />
      ) : (
        <AppErrorFallback onRetry={this.reset} />
      );
    }
    return this.props.children;
  }
}
