import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";

import { QuarantineReason } from "@rondyr/contracts/classification";
import { DeliveryStatus } from "@rondyr/deliveries/delivery";

import { ReasonLabel } from "~/components/reason-label";
import { ReadFailure } from "~/components/read-failure";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { Skeleton } from "~/components/ui/skeleton";
import { operationsQuery, refreshOperations, type OrganizationStatus } from "~/lib/api/operations";
import { useFormats } from "~/lib/i18n";

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
  readonly label: ReactNode;
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
  readonly organization: OrganizationStatus;
}

function OrganizationMetrics({ organization }: OrganizationMetricsProps) {
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
                    label={<ReasonLabel reason={reason} />}
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
            <StuckSubmissions organizationId={organization.id} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// The value of the sentence about the Cron, in the color of the text.
const cronValue = <span className="font-medium text-foreground tabular-nums" />;

const metricColumns = [0, 1, 2] as const;
const metricRows = [0, 1, 2, 3] as const;

function OperationsSkeleton({ label }: { readonly label: string }) {
  return (
    <div className="grid gap-4">
      <output className="sr-only">{label}</output>
      <Skeleton className="h-4 w-64 max-w-full" />
      <Card aria-hidden="true">
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-x-10 gap-y-6 md:grid-cols-3">
            {metricColumns.map((column) => (
              <div key={column} className="grid content-start gap-2.5">
                <Skeleton className="h-4 w-28" />
                {metricRows.map((row) => (
                  <div key={row} className="flex items-center justify-between gap-4 py-1">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3.5 w-8" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** How the processing of every organization of the account is doing: Cron, queues and deliveries. */
export function OperationsPanel() {
  const { t } = useTranslation();
  const format = useFormats();
  const status = useQuery(operationsQuery);
  const queryClient = useQueryClient();

  return (
    <main className="flex min-h-0 min-w-0 flex-col lg:col-span-2">
      <header className="flex h-14 shrink-0 items-center gap-1 bg-background hairline-b px-1">
        <SidebarTrigger />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{t("operations.title")}</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("common.refresh")}
          disabled={status.isFetching}
          onClick={() => void refreshOperations(queryClient)}
        >
          <RefreshCw
            aria-hidden="true"
            className={cn(
              "size-4",
              status.isFetching && !status.isPending && "animate-spin motion-reduce:animate-none",
            )}
          />
        </Button>
      </header>
      <div className="min-h-0 flex-1 lg:overflow-y-auto">
        <div className="mx-auto grid max-w-4xl gap-4 px-5 py-5">
          {status.isPending && <OperationsSkeleton label={t("operations.loading")} />}
          {status.isError && (
            <ReadFailure
              cause={status.error}
              title={t("operations.unavailable")}
              retry={t("common.retry")}
              retrying={status.isFetching}
              onRetry={() => void status.refetch()}
            />
          )}
          {status.isSuccess && (
            <>
              <p className="text-sm text-muted-foreground">
                {status.data.lastSuccessfulCronAt === null ? (
                  <Trans i18nKey="operations.cron.never" components={{ value: cronValue }} />
                ) : (
                  <Trans
                    i18nKey="operations.cron.last"
                    values={{ date: format.timestamp(status.data.lastSuccessfulCronAt) }}
                    components={{ value: cronValue }}
                  />
                )}
              </p>
              {status.data.organizations.length === 0 && (
                <p className="text-sm text-muted-foreground">{t("operations.noOrganizations")}</p>
              )}
              {status.data.organizations.map((organization) => (
                <OrganizationMetrics key={organization.id} organization={organization} />
              ))}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
