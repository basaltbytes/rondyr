import { cn } from "cn";
import { Schema } from "effect";
import { RefreshCw } from "lucide-react";
import { useActionState, useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { listDeliveries, retryDelivery } from "~/lib/deliveries-client";
import type { Delivery } from "~/lib/deliveries-client";
import { InboxRequestError } from "~/lib/inbox-client";
import type { Inbox, Submission } from "~/lib/inbox-client";

import { deliveryStatusLabels } from "~/lib/status-labels";

import { attemptOutcomeLabels } from "./strings.ts";

const date = new Intl.DateTimeFormat("fr", { dateStyle: "short", timeStyle: "medium" });

const isRequestError = Schema.is(InboxRequestError);

const statusTones = {
  pending: "text-muted-foreground",
  processing: "text-muted-foreground",
  delivered: "text-success",
  retrying: "text-warning",
  failed: "text-destructive",
} as const;

function attemptsLabel(count: number) {
  return count === 1 ? "1 tentative" : `${count} tentatives`;
}

function Destination({ delivery }: { readonly delivery: Delivery }) {
  const { destination } = delivery;
  return destination.type === "webhook" ? (
    <>
      Webhook <code className="font-mono text-xs">{destination.url}</code>
    </>
  ) : (
    <>E-mail à {destination.recipients.join(", ")}</>
  );
}

interface DeliveryHistoryProps {
  readonly inboxId: Inbox["id"];
  readonly submissionId: Submission["submissionId"];
  readonly revision: number;
}

export function DeliveryHistory({ inboxId, submissionId, revision }: DeliveryHistoryProps) {
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

  const [problem, retry, retrying] = useActionState(async (_: string | null, form: FormData) => {
    const delivery = deliveries?.find(({ id }) => id === form.get("delivery"));
    if (delivery === undefined) return null;
    try {
      setDeliveries(await retryDelivery(inboxId, submissionId, delivery.id));
      return null;
    } catch (error) {
      if (isRequestError(error) && error.status === 409) {
        refresh();
        return "Cette livraison n’est plus en échec : la liste est actualisée.";
      }
      return "La relance n’a pas pu être enregistrée. Réessayez.";
    }
  }, null);

  return (
    <section aria-label="Livraisons du message" className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Livraisons</h3>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Actualiser les livraisons"
          onClick={refresh}
        >
          <RefreshCw aria-hidden="true" className="size-4" />
        </Button>
      </div>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          Impossible de charger les livraisons.
        </p>
      )}
      {deliveries === null && !failed && (
        <output className="text-sm text-muted-foreground">Chargement des livraisons…</output>
      )}
      {deliveries?.length === 0 && (
        <p className="text-sm text-muted-foreground">Aucune livraison pour ce message.</p>
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
                  {deliveryStatusLabels[delivery.status]}
                </p>
              </div>
              {delivery.status === "failed" && delivery.lastError !== null && (
                <p className="text-xs wrap-anywhere text-destructive">{delivery.lastError}</p>
              )}
              {delivery.nextAttemptAt !== null && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  Prochaine tentative après le {date.format(delivery.nextAttemptAt)}
                </p>
              )}
              {delivery.attempts.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer py-1 tabular-nums">
                    {attemptsLabel(delivery.attemptCount)}
                  </summary>
                  <ol className="grid gap-1 pt-1 tabular-nums">
                    {delivery.attempts.map((attempt) => (
                      <li key={attempt.attempt} className="wrap-anywhere">
                        Tentative {attempt.attempt} : {date.format(attempt.startedAt)}
                        {attempt.finishedAt === null
                          ? " · en cours"
                          : ` → ${date.format(attempt.finishedAt)}`}
                        {attempt.outcome !== null && ` · ${attemptOutcomeLabels[attempt.outcome]}`}
                        {attempt.error !== null && ` · ${attempt.error}`}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {delivery.status === "failed" && (
                <form action={retry}>
                  <input type="hidden" name="delivery" value={delivery.id} />
                  <Button type="submit" disabled={retrying}>
                    Relancer la livraison
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {problem !== null && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </section>
  );
}
