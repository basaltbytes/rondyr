import { Schema } from "effect";
import { useActionState, useEffect, useState } from "react";

import { listDeliveries, retryDelivery } from "~/lib/deliveries-client";
import type { Delivery } from "~/lib/deliveries-client";
import { InboxRequestError } from "~/lib/inbox-client";
import type { Inbox, Submission } from "~/lib/inbox-client";

import { attemptOutcomeLabels, deliveryStatusLabels } from "./strings.ts";

const date = new Intl.DateTimeFormat("fr", { dateStyle: "short", timeStyle: "medium" });

const isRequestError = Schema.is(InboxRequestError);

function attemptsLabel(count: number) {
  return count === 1 ? "1 tentative" : `${count} tentatives`;
}

function Destination({ delivery }: { readonly delivery: Delivery }) {
  const { destination } = delivery;
  return destination.type === "webhook" ? (
    <>
      Webhook <code>{destination.url}</code>
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
    <section aria-label="Livraisons du message">
      <h4>Livraisons</h4>
      {failed && <p role="alert">Impossible de charger les livraisons.</p>}
      {deliveries === null && !failed && <output>Chargement des livraisons…</output>}
      {deliveries?.length === 0 && <p>Aucune livraison pour ce message.</p>}
      {deliveries !== null && deliveries.length > 0 && (
        <ul>
          {deliveries.map((delivery) => (
            <li key={delivery.id}>
              <p>
                <Destination delivery={delivery} /> · {deliveryStatusLabels[delivery.status]} ·{" "}
                {attemptsLabel(delivery.attemptCount)}
                {delivery.nextAttemptAt !== null &&
                  ` · prochaine tentative après le ${date.format(delivery.nextAttemptAt)}`}
              </p>
              {delivery.status === "failed" && delivery.lastError !== null && (
                <p>{delivery.lastError}</p>
              )}
              {delivery.attempts.length > 0 && (
                <ol>
                  {delivery.attempts.map((attempt) => (
                    <li key={attempt.attempt}>
                      Tentative {attempt.attempt} : {date.format(attempt.startedAt)}
                      {attempt.finishedAt === null
                        ? " · en cours"
                        : ` → ${date.format(attempt.finishedAt)}`}
                      {attempt.outcome !== null && ` · ${attemptOutcomeLabels[attempt.outcome]}`}
                      {attempt.error !== null && ` · ${attempt.error}`}
                    </li>
                  ))}
                </ol>
              )}
              {delivery.status === "failed" && (
                <form action={retry} className="inbox-actions">
                  <input type="hidden" name="delivery" value={delivery.id} />
                  <button type="submit" disabled={retrying}>
                    Relancer la livraison
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {problem !== null && <p role="alert">{problem}</p>}
      <div className="inbox-actions">
        <button type="button" onClick={refresh}>
          Actualiser les livraisons
        </button>
      </div>
    </section>
  );
}
