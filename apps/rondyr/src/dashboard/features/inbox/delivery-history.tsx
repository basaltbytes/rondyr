import { cn } from "cn";
import { Schema } from "effect";
import { RefreshCw } from "lucide-react";
import { useActionState, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { connectorOf } from "@rondyr/deliveries/connectors/catalog";

import { Button } from "~/components/ui/button";
import { listDeliveries, retryDelivery } from "~/lib/deliveries-client";
import type { Delivery } from "~/lib/deliveries-client";
import { useFormats } from "~/lib/i18n";
import { InboxRequestError } from "~/lib/inbox-client";
import type { Inbox, Submission } from "~/lib/inbox-client";

const isRequestError = Schema.is(InboxRequestError);

/** Why a retry was not applied. Each one names a message of `inbox.deliveries.problems`. */
type RetryProblem = "noLongerFailed" | "retryNotSaved";

const statusTones = {
  pending: "text-muted-foreground",
  processing: "text-muted-foreground",
  delivered: "text-success",
  retrying: "text-warning",
  failed: "text-destructive",
} as const;

function Destination({ delivery }: { readonly delivery: Delivery }) {
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
  readonly inboxId: Inbox["id"];
  readonly submissionId: Submission["submissionId"];
  readonly revision: number;
  /** A reviewer reads the deliveries; an admin may also retry a failed one. */
  readonly canRetry: boolean;
}

export function DeliveryHistory({
  inboxId,
  submissionId,
  revision,
  canRetry,
}: DeliveryHistoryProps) {
  const { t } = useTranslation();
  const format = useFormats();
  const [deliveries, setDeliveries] = useState<readonly Delivery[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);

  function refresh() {
    setFailed(false);
    setReload((value) => value + 1);
  }

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the deliveries of the message from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listDeliveries(inboxId, submissionId, request.signal).then(setDeliveries, () => {
      if (!request.signal.aborted) setFailed(true);
    });
    return () => request.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A refresh of the inbox or of this list initiates a new API request.
  }, [inboxId, submissionId, revision, reload]);

  const [problem, retry, retrying] = useActionState(
    async (_: RetryProblem | null, form: FormData): Promise<RetryProblem | null> => {
      const delivery = deliveries?.find(({ id }) => id === form.get("delivery"));
      if (delivery === undefined) return null;
      try {
        setDeliveries(await retryDelivery(inboxId, submissionId, delivery.id));
        return null;
      } catch (error) {
        if (isRequestError(error) && error.status === 409) {
          refresh();
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
          onClick={refresh}
        >
          <RefreshCw aria-hidden="true" className="size-4" />
        </Button>
      </div>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t("inbox.deliveries.loadFailed")}
        </p>
      )}
      {deliveries === null && !failed && (
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
