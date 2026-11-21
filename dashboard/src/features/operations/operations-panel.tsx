import { cn } from "cn";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { QuarantineReason } from "@rondyr/contracts/classification";
import type { OperationsStatus, OrganizationStatus } from "@rondyr/contracts/operations-status";
import { DeliveryStatus } from "@rondyr/deliveries/delivery";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { useFormats } from "~/lib/i18n";
import { readOperationsStatus } from "~/lib/operations-client";

import { StuckSubmissions } from "./stuck-submissions.tsx";

// A count that asks for attention has the color of its status. Zero is quiet.
const deliveryTones = {
  pending: "text-foreground",
  processing: "text-foreground",
  delivered: "text-foreground",
  retrying: "text-warning",
  failed: "text-destructive",
} as const;

interface FigureProps {
  readonly label: string;
  readonly value: string;
  /** The class of a value that is not zero. */
  readonly tone?: string;
  readonly quiet: boolean;
}

/** One figure of a group: its name on the left, its value in digits of equal width on the right. */
function Figure({ label, value, tone, quiet }: FigureProps) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="min-w-0 text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "shrink-0 font-medium tabular-nums",
          quiet ? "text-muted-foreground" : (tone ?? "text-foreground"),
        )}
      >
        {value}
      </dd>
    </div>
  );
}

interface OrganizationMetricsProps {
  readonly organization: typeof OrganizationStatus.Type;
  /** Reads the status again after a change on this page. */
  readonly onChanged: () => void;
}

function OrganizationMetrics({ organization, onChanged }: OrganizationMetricsProps) {
  const { t } = useTranslation();
  const format = useFormats();
  const { outbox, deliveries, receivedLast24h, quarantinedLast24h } = organization;
  return (
    <Card aria-label={t("operations.organization", { name: organization.name })}>
      <CardHeader>
        <CardTitle>{organization.name}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-x-10 gap-y-6 text-sm md:grid-cols-3">
          <section className="grid content-start gap-1">
            <h4 className="font-medium">{t("operations.queue.title")}</h4>
            <dl>
              <Figure
                label={t("operations.queue.pending")}
                value={format.count(outbox.count)}
                tone="text-warning"
                quiet={outbox.count === 0}
              />
              <Figure
                label={t("operations.queue.oldestAge")}
                value={
                  outbox.oldestAgeMs === null
                    ? t("operations.queue.empty")
                    : format.age(outbox.oldestAgeMs)
                }
                quiet={outbox.oldestAgeMs === null}
              />
              <Figure
                label={t("operations.queue.stuck")}
                value={format.count(outbox.stuck)}
                tone="text-destructive"
                quiet={outbox.stuck === 0}
              />
            </dl>
          </section>
          <section className="grid content-start gap-1">
            <h4 className="font-medium">{t("operations.deliveries.title")}</h4>
            <dl>
              {DeliveryStatus.literals.map((status) => {
                const count = deliveries.find((entry) => entry.status === status)?.count ?? 0;
                return (
                  <Figure
                    key={status}
                    label={t(`status.deliveries.${status}`)}
                    value={format.count(count)}
                    tone={deliveryTones[status]}
                    quiet={count === 0}
                  />
                );
              })}
            </dl>
          </section>
          <section className="grid content-start gap-1">
            <h4 className="font-medium">{t("operations.lastDay.title")}</h4>
            <dl>
              <Figure
                label={t("operations.lastDay.received")}
                value={format.count(receivedLast24h)}
                quiet={receivedLast24h === 0}
              />
            </dl>
            <h4 className="pt-2 font-medium">{t("operations.lastDay.quarantined")}</h4>
            <dl>
              {QuarantineReason.literals.map((reason) => {
                const count =
                  quarantinedLast24h.find((entry) => entry.reason === reason)?.count ?? 0;
                return (
                  <Figure
                    key={reason}
                    label={t(`status.reasons.${reason}`)}
                    value={format.count(count)}
                    tone="text-warning"
                    quiet={count === 0}
                  />
                );
              })}
            </dl>
          </section>
        </div>
        {outbox.stuck > 0 && (
          <div className="mt-6 hairline-t pt-4">
            <StuckSubmissions organizationId={organization.id} onRetried={onChanged} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// The value of the sentence about the Cron, in the color of the text.
const cronValue = <span className="font-medium text-foreground tabular-nums" />;

type Status =
  | { readonly kind: "loading" | "failed" }
  | { readonly kind: "ready"; readonly snapshot: typeof OperationsStatus.Type };

/** How the processing of every organization of the account is doing: Cron, queues and deliveries. */
export function OperationsPanel() {
  const { t } = useTranslation();
  const format = useFormats();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [revision, setRevision] = useState(0);

  function refresh() {
    setStatus({ kind: "loading" });
    setRevision((value) => value + 1);
  }

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Reads the processing status from the Rondyr API when the page opens or refreshes.
  useEffect(() => {
    let current = true;
    void readOperationsStatus().then(
      (snapshot) => {
        if (current) setStatus({ kind: "ready", snapshot });
      },
      () => {
        if (current) setStatus({ kind: "failed" });
      },
    );
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A refresh initiates a new API request.
  }, [revision]);

  return (
    <main className="flex min-h-0 min-w-0 flex-col lg:col-span-2">
      <header className="flex h-14 shrink-0 items-center gap-1 bg-card hairline-b px-1">
        <SidebarTrigger />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{t("operations.title")}</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("common.refresh")}
          disabled={status.kind === "loading"}
          onClick={refresh}
        >
          <RefreshCw aria-hidden="true" className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 lg:overflow-y-auto">
        <div className="mx-auto grid max-w-4xl gap-4 px-5 py-5">
          {status.kind === "loading" && (
            <output className="text-sm text-muted-foreground">{t("operations.loading")}</output>
          )}
          {status.kind === "failed" && (
            <p role="alert" className="text-sm text-destructive">
              {t("operations.unavailable")}
            </p>
          )}
          {status.kind === "ready" && (
            <>
              <p className="text-sm text-muted-foreground">
                {status.snapshot.lastSuccessfulCronAt === null ? (
                  <Trans i18nKey="operations.cron.never" components={{ value: cronValue }} />
                ) : (
                  <Trans
                    i18nKey="operations.cron.last"
                    values={{ date: format.timestamp(status.snapshot.lastSuccessfulCronAt) }}
                    components={{ value: cronValue }}
                  />
                )}
              </p>
              {status.snapshot.organizations.length === 0 && (
                <p className="text-sm text-muted-foreground">{t("operations.noOrganizations")}</p>
              )}
              {status.snapshot.organizations.map((organization) => (
                <OrganizationMetrics
                  key={organization.id}
                  organization={organization}
                  onChanged={refresh}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
