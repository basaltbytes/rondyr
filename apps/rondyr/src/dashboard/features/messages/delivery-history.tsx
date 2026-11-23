import { useMutation, useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { RefreshCw } from "lucide-react";
import { useActionState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { connectorOf } from "@rondyr/deliveries/connectors/catalog";

import { ReadFailure } from "~/components/read-failure";
import { Button } from "~/components/ui/button";
import { deliveriesQuery, retryDeliveryMutation, type DeliveryRecord } from "~/lib/api/deliveries";
import { statusOf } from "~/lib/api/request";
import { useFormats } from "~/lib/i18n";

/** Why a retry was not applied. Each one names a message of `inbox.deliveries.problems`. */
type RetryProblem = "noLongerFailed" | "retryNotSaved";

const statusTones = {
  pending: "text-muted-foreground",
  processing: "text-muted-foreground",
  delivered: "text-success",
  retrying: "text-warning",
  failed: "text-destructive",
} as const;

function Destination({ delivery }: { readonly delivery: DeliveryRecord }) {
  const { t } = useTranslation();
  const { destination } = delivery;
  if (destination.type === "webhook") {
    return (
      <Trans
        i18nKey="inbox.deliveries.webhook"
        values={{ url: destination.url }}
        components={{ code: <code className="font-mono text-xs" /> }}
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
    <section aria-label={t("inbox.deliveries.label")} className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t("inbox.deliveries.title")}</h3>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("inbox.deliveries.refresh")}
          onClick={() => void history.refetch()}
        >
          <RefreshCw aria-hidden="true" className="size-4" />
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
        <output className="text-sm text-muted-foreground">{t("inbox.deliveries.loading")}</output>
      )}
      {deliveries?.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("inbox.deliveries.empty")}</p>
      )}
      {deliveries !== null && deliveries.length > 0 && (
        <ul className="grid gap-px overflow-hidden rounded-md bg-border shadow-raised">
          {deliveries.map((delivery) => (
            <li key={delivery.id} className="grid gap-2 bg-card px-3 py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="min-w-0 flex-1 basis-48 wrap-anywhere">
                  <Destination delivery={delivery} />
                </p>
                <p className={cn("text-xs font-medium", statusTones[delivery.status])}>
                  {t(`status.deliveries.${delivery.status}`)}
                </p>
              </div>
              {delivery.status === "failed" && delivery.lastError !== null && (
                <p className="text-xs wrap-anywhere text-destructive">{delivery.lastError}</p>
              )}
              {delivery.nextAttemptAt !== null && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  {t("inbox.deliveries.nextAttempt", {
                    date: format.timestamp(delivery.nextAttemptAt),
                  })}
                </p>
              )}
              {delivery.attempts.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer py-1 tabular-nums">
                    {t("inbox.deliveries.attempts", { count: delivery.attemptCount })}
                  </summary>
                  <ol className="grid gap-1 pt-1 tabular-nums">
                    {delivery.attempts.map((attempt) => (
                      <li key={attempt.attempt} className="wrap-anywhere">
                        {attempt.finishedAt === null
                          ? t("inbox.deliveries.attemptRunning", {
                              attempt: t("inbox.deliveries.attempt", { number: attempt.attempt }),
                              startedAt: format.timestamp(attempt.startedAt),
                            })
                          : t("inbox.deliveries.attemptFinished", {
                              attempt: t("inbox.deliveries.attempt", { number: attempt.attempt }),
                              startedAt: format.timestamp(attempt.startedAt),
                              finishedAt: format.timestamp(attempt.finishedAt),
                            })}
                        {attempt.outcome !== null &&
                          ` · ${t(`inbox.deliveries.outcomes.${attempt.outcome}`)}`}
                        {attempt.error !== null && ` · ${attempt.error}`}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {canRetry && delivery.status === "failed" && (
                <form action={retry}>
                  <input type="hidden" name="delivery" value={delivery.id} />
                  <Button type="submit" disabled={retrying}>
                    {t("inbox.deliveries.retry")}
                  </Button>
                </form>
              )}
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
