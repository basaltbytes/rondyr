import { useMutation, useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { ChevronRight, Mail, Plug, RefreshCw, RotateCw, Webhook } from "lucide-react";
import { useActionState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { connectorOf } from "@rondyr/deliveries/connectors/catalog";

import { ReadFailure } from "~/components/read-failure";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { deliveriesQuery, retryDeliveryMutation, type DeliveryRecord } from "~/lib/api/deliveries";
import { statusOf } from "~/lib/api/request";
import { useFormats } from "~/lib/i18n";

/** Why a retry was not applied. Each one names a message of `inbox.deliveries.problems`. */
type RetryProblem = "noLongerFailed" | "retryNotSaved";

const statusBadges = {
  pending: "neutral",
  processing: "neutral",
  delivered: "success",
  retrying: "warning",
  failed: "destructive",
} as const;

const outcomeTones = {
  delivered: "font-medium text-success",
  "retryable-failure": "font-medium text-warning",
  "permanent-failure": "font-medium text-destructive",
  interrupted: "text-muted-foreground",
} as const;

const skeletonRows = [0, 1] as const;

function DestinationIcon({ type }: { readonly type: DeliveryRecord["destination"]["type"] }) {
  const Icon = type === "webhook" ? Webhook : type === "email" ? Mail : Plug;
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
    >
      <Icon className="size-3.5" />
    </span>
  );
}

function Destination({ delivery }: { readonly delivery: DeliveryRecord }) {
  const { t } = useTranslation();
  const { destination } = delivery;
  if (destination.type === "webhook") {
    return (
      <Trans
        i18nKey="inbox.deliveries.webhook"
        values={{ url: destination.url }}
        components={{
          code: <code className="ml-1 font-mono text-xs font-normal text-muted-foreground" />,
        }}
      />
    );
  }
  if (destination.type === "email") {
    return <>{t("inbox.deliveries.email", { recipients: destination.recipients.join(", ") })}</>;
  }
  return (
    <>
      {t("inbox.deliveries.connector", {
        service: connectorOf(destination.type).label,
        name: destination.name,
      })}
    </>
  );
}

interface DeliveryHistoryProps {
  readonly organizationId: string;
  readonly submissionId: string;
  /** A reviewer reads the deliveries; an admin may also retry a failed one. */
  readonly canRetry: boolean;
}

export function DeliveryHistory({ organizationId, submissionId, canRetry }: DeliveryHistoryProps) {
  const { t } = useTranslation();
  const format = useFormats();
  const history = useQuery(deliveriesQuery(organizationId, submissionId));
  const retryDelivery = useMutation(retryDeliveryMutation(organizationId, submissionId));
  const deliveries = history.isError ? null : (history.data ?? null);

  const [problem, retry, retrying] = useActionState(
    async (_: RetryProblem | null, form: FormData): Promise<RetryProblem | null> => {
      const delivery = deliveries?.find(({ id }) => id === form.get("delivery"));
      if (delivery === undefined) return null;
      try {
        await retryDelivery.mutateAsync(delivery.id);
        return null;
      } catch (cause) {
        if (statusOf(cause) === 409) {
          void history.refetch();
          return "noLongerFailed";
        }
        return "retryNotSaved";
      }
    },
    null,
  );

  return (
    <section aria-label={t("inbox.deliveries.label")} className="grid gap-3 hairline-t pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t("inbox.deliveries.title")}</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("inbox.deliveries.refresh")}
          onClick={() => void history.refetch()}
        >
          <RefreshCw
            aria-hidden="true"
            className={cn(
              "size-4",
              history.isFetching && "animate-spin motion-reduce:animate-none",
            )}
          />
        </Button>
      </div>
      {history.isError && (
        <ReadFailure
          cause={history.error}
          title={t("inbox.deliveries.loadFailed")}
          retry={t("common.retry")}
          retrying={history.isFetching}
          onRetry={() => void history.refetch()}
        />
      )}
      {history.isPending && (
        <div>
          <output className="sr-only">{t("inbox.deliveries.loading")}</output>
          <div aria-hidden="true" className="divide-y divide-border">
            {skeletonRows.map((row) => (
              <div key={row} className="flex items-start gap-3 py-3 first:pt-1 last:pb-0">
                <Skeleton variant="circle" className="mt-0.5 size-7 shrink-0" />
                <div className="grid min-w-0 flex-1 gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <Skeleton className="h-4 w-56 max-w-full" />
                    <Skeleton className="h-5 w-20 shrink-0" />
                  </div>
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {deliveries?.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("inbox.deliveries.empty")}</p>
      )}
      {deliveries !== null && deliveries.length > 0 && (
        <ul className="divide-y divide-border">
          {deliveries.map((delivery) => (
            <li key={delivery.id} className="grid gap-2 py-3 text-sm first:pt-1 last:pb-0">
              <div className="flex items-start gap-3">
                <DestinationIcon type={delivery.destination.type} />
                <div className="grid min-w-0 flex-1 gap-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <p className="min-w-0 flex-1 basis-44 font-medium wrap-anywhere">
                      <Destination delivery={delivery} />
                    </p>
                    <Badge variant={statusBadges[delivery.status]}>
                      {t(`status.deliveries.${delivery.status}`)}
                    </Badge>
                  </div>
                  {delivery.status === "failed" && delivery.lastError !== null && (
                    <p className="border-l-2 border-destructive/40 pl-2.5 text-xs wrap-anywhere text-destructive">
                      {delivery.lastError}
                    </p>
                  )}
                  {delivery.nextAttemptAt !== null && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {t("inbox.deliveries.nextAttempt", {
                        date: format.timestamp(delivery.nextAttemptAt),
                      })}
                    </p>
                  )}
                  {delivery.attempts.length > 0 && (
                    <details className="group text-xs">
                      <summary className="details-summary inline-flex cursor-pointer items-center gap-1 py-0.5 text-muted-foreground tabular-nums transition-colors duration-150 hover:text-foreground">
                        <ChevronRight
                          aria-hidden="true"
                          className="size-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
                        />
                        <span>
                          {t("inbox.deliveries.attempts", { count: delivery.attemptCount })}
                        </span>
                      </summary>
                      <ol className="mt-1.5 grid gap-1.5 border-l border-border pl-3 text-muted-foreground tabular-nums">
                        {delivery.attempts.map((attempt) => (
                          <li key={attempt.attempt} className="wrap-anywhere">
                            {attempt.finishedAt === null
                              ? t("inbox.deliveries.attemptRunning", {
                                  attempt: t("inbox.deliveries.attempt", {
                                    number: attempt.attempt,
                                  }),
                                  startedAt: format.timestamp(attempt.startedAt),
                                })
                              : t("inbox.deliveries.attemptFinished", {
                                  attempt: t("inbox.deliveries.attempt", {
                                    number: attempt.attempt,
                                  }),
                                  startedAt: format.timestamp(attempt.startedAt),
                                  finishedAt: format.timestamp(attempt.finishedAt),
                                })}
                            {attempt.outcome !== null && (
                              <span className={outcomeTones[attempt.outcome]}>
                                {` · ${t(`inbox.deliveries.outcomes.${attempt.outcome}`)}`}
                              </span>
                            )}
                            {attempt.error !== null && ` · ${attempt.error}`}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                  {canRetry && delivery.status === "failed" && (
                    <form action={retry} className="pt-0.5">
                      <input type="hidden" name="delivery" value={delivery.id} />
                      <Button type="submit" size="sm" disabled={retrying}>
                        <RotateCw aria-hidden="true" className="size-3.5" />
                        {t("inbox.deliveries.retry")}
                      </Button>
                    </form>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {problem !== null && (
        <p role="alert" className="text-sm text-destructive">
          {t(`inbox.deliveries.problems.${problem}`)}
        </p>
      )}
    </section>
  );
}
