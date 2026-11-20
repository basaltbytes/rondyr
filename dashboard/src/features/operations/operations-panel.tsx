import { cn } from "cn";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { QuarantineReason } from "@rondyr/contracts/classification";
import type { OperationsStatus, OrganizationStatus } from "@rondyr/contracts/operations-status";
import { DeliveryStatus } from "@rondyr/deliveries/delivery";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { SidebarTrigger } from "~/components/ui/sidebar";
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
}

function OrganizationMetrics({ organization }: OrganizationMetricsProps) {
  const { outbox, deliveries, receivedLast24h, quarantinedLast24h } = organization;
  return (
    <Card aria-label={`État de ${organization.name}`}>
      <CardHeader>
        <CardTitle>{organization.name}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-x-10 gap-y-6 text-sm md:grid-cols-3">
          <section className="grid content-start gap-1">
            <h4 className="font-medium">File de classification</h4>
            <dl>
              <Figure
                label="Événements non remis"
                value={number.format(outbox.count)}
                tone="text-warning"
                quiet={outbox.count === 0}
              />
              <Figure
                label="Âge du plus ancien"
                value={outbox.oldestAgeMs === null ? "Aucun" : age(outbox.oldestAgeMs)}
                quiet={outbox.oldestAgeMs === null}
              />
            </dl>
          </section>
          <section className="grid content-start gap-1">
            <h4 className="font-medium">Livraisons</h4>
            <dl>
              {DeliveryStatus.literals.map((status) => {
                const count = deliveries.find((entry) => entry.status === status)?.count ?? 0;
                return (
                  <Figure
                    key={status}
                    label={deliveryStatusLabels[status]}
                    value={number.format(count)}
                    tone={deliveryTones[status]}
                    quiet={count === 0}
                  />
                );
              })}
            </dl>
          </section>
          <section className="grid content-start gap-1">
            <h4 className="font-medium">Dernières 24 h</h4>
            <dl>
              <Figure
                label="Messages reçus"
                value={number.format(receivedLast24h)}
                quiet={receivedLast24h === 0}
              />
            </dl>
            <h4 className="pt-2 font-medium">Encore en quarantaine, par motif</h4>
            <dl>
              {QuarantineReason.literals.map((reason) => {
                const count =
                  quarantinedLast24h.find((entry) => entry.reason === reason)?.count ?? 0;
                return (
                  <Figure
                    key={reason}
                    label={reviewReasons[reason]}
                    value={number.format(count)}
                    tone="text-warning"
                    quiet={count === 0}
                  />
                );
              })}
            </dl>
          </section>
        </div>
      </CardContent>
    </Card>
  );
}

type Status =
  | { readonly kind: "loading" | "failed" }
  | { readonly kind: "ready"; readonly snapshot: typeof OperationsStatus.Type };

/** How the processing of every organization of the account is doing: Cron, queues and deliveries. */
export function OperationsPanel() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [revision, setRevision] = useState(0);

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
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">État</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Actualiser"
          disabled={status.kind === "loading"}
          onClick={() => {
            setStatus({ kind: "loading" });
            setRevision((value) => value + 1);
          }}
        >
          <RefreshCw aria-hidden="true" className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 lg:overflow-y-auto">
        <div className="mx-auto grid max-w-4xl gap-4 px-5 py-5">
          {status.kind === "loading" && (
            <output className="text-sm text-muted-foreground">Chargement de l’état…</output>
          )}
          {status.kind === "failed" && (
            <p role="alert" className="text-sm text-destructive">
              L’état du traitement est indisponible. Réessayez.
            </p>
          )}
          {status.kind === "ready" && (
            <>
              <p className="text-sm text-muted-foreground">
                Dernière exécution réussie du Cron :{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {status.snapshot.lastSuccessfulCronAt === null
                    ? "aucune réussite enregistrée"
                    : date.format(status.snapshot.lastSuccessfulCronAt)}
                </span>
              </p>
              {status.snapshot.organizations.length === 0 && (
                <p className="text-sm text-muted-foreground">Aucune organisation.</p>
              )}
              {status.snapshot.organizations.map((organization) => (
                <OrganizationMetrics key={organization.id} organization={organization} />
              ))}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
