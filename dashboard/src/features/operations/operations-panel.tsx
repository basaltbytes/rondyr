import { useState } from "react";

import { DeliveryStatus } from "@rondyr/deliveries/delivery";
import { QuarantineReason } from "@rondyr/contracts/classification";
import type { OperationsStatus, OrganizationStatus } from "@rondyr/contracts/operations-status";

import { readOperationsStatus } from "~/lib/operations-client";
import { deliveryStatusLabels, reviewReasons } from "~/lib/status-labels";

const date = new Intl.DateTimeFormat("fr", { dateStyle: "short", timeStyle: "medium" });
const number = new Intl.NumberFormat("fr");
const seconds = new Intl.NumberFormat("fr", { style: "unit", unit: "second" });
const minutes = new Intl.NumberFormat("fr", { style: "unit", unit: "minute" });
const hours = new Intl.NumberFormat("fr", { style: "unit", unit: "hour" });

function age(millis: number) {
  const elapsed = Math.floor(millis / 1000);
  if (elapsed < 60) return seconds.format(elapsed);
  if (elapsed < 3600) return minutes.format(Math.floor(elapsed / 60));
  return hours.format(Math.floor(elapsed / 3600));
}

function OrganizationMetrics({ organization }: { organization: typeof OrganizationStatus.Type }) {
  const { outbox, deliveries, receivedLast24h, quarantinedLast24h } = organization;
  return (
    <section>
      <h3>{organization.name}</h3>
      <div className="operations-metrics">
        <div>
          <h4>File de classification</h4>
          <dl>
            <dt>Événements non remis</dt>
            <dd>{number.format(outbox.count)}</dd>
            <dt>Âge du plus ancien</dt>
            <dd>{outbox.oldestAgeMs === null ? "Aucun événement" : age(outbox.oldestAgeMs)}</dd>
          </dl>
        </div>
        <div>
          <h4>Livraisons</h4>
          <dl>
            {DeliveryStatus.literals.map((status) => (
              <div key={status}>
                <dt>{deliveryStatusLabels[status]}</dt>
                <dd>
                  {number.format(deliveries.find((entry) => entry.status === status)?.count ?? 0)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h4>Messages reçus au cours des dernières 24 h</h4>
          <dl>
            <dt>Total</dt>
            <dd>{number.format(receivedLast24h)}</dd>
          </dl>
          <h4>Encore en quarantaine, par motif</h4>
          <dl>
            {QuarantineReason.literals.map((reason) => (
              <div key={reason}>
                <dt>{reviewReasons[reason]}</dt>
                <dd>
                  {number.format(
                    quarantinedLast24h.find((entry) => entry.reason === reason)?.count ?? 0,
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

type Status =
  | { readonly kind: "idle" | "loading" | "failed" }
  | { readonly kind: "ready"; readonly snapshot: typeof OperationsStatus.Type };

export function OperationsPanel() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function refresh() {
    setStatus({ kind: "loading" });
    try {
      setStatus({ kind: "ready", snapshot: await readOperationsStatus() });
    } catch {
      setStatus({ kind: "failed" });
    }
  }

  return (
    <section className="operations" aria-labelledby="operations-heading">
      <h2 id="operations-heading">État</h2>
      <details
        onToggle={(event) => {
          if (event.currentTarget.open && status.kind === "idle") void refresh();
        }}
      >
        <summary>Voir l’état du traitement</summary>
        <button type="button" onClick={() => void refresh()} disabled={status.kind === "loading"}>
          Actualiser
        </button>
        {status.kind === "loading" && (
          <p>
            <output>Chargement de l’état…</output>
          </p>
        )}
        {status.kind === "failed" && (
          <p role="alert">L’état du traitement est indisponible. Réessayez.</p>
        )}
        {status.kind === "ready" && (
          <>
            <dl>
              <dt>Dernière exécution réussie du Cron</dt>
              <dd>
                {status.snapshot.lastSuccessfulCronAt === null
                  ? "Aucune réussite enregistrée"
                  : date.format(status.snapshot.lastSuccessfulCronAt)}
              </dd>
            </dl>
            {status.snapshot.organizations.length === 0 && <p>Aucune organisation.</p>}
            {status.snapshot.organizations.map((organization) => (
              <OrganizationMetrics key={organization.id} organization={organization} />
            ))}
          </>
        )}
      </details>
    </section>
  );
}
