import { useActionState, useEffect, useState } from "react";

import { FormProblem, TextField } from "~/components/text-field";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import type { Inbox } from "~/lib/inbox-client";
import {
  createWebhook,
  isWebhook,
  listTargets,
  rotateSecret,
  setTargetActive,
} from "~/lib/targets-client";
import type { IssuedSecret, Webhook } from "~/lib/targets-client";

import { attempt } from "./target-problems.ts";
import { TargetTest } from "./target-test.tsx";

const date = new Intl.DateTimeFormat("fr", { dateStyle: "short", timeStyle: "short" });

interface WebhookTargetsProps {
  readonly inboxId: Inbox["id"];
  readonly form: Inbox["forms"][number];
}

export function WebhookTargets({ inboxId, form }: WebhookTargetsProps) {
  const [targets, setTargets] = useState<readonly Webhook[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [issued, setIssued] = useState<IssuedSecret | null>(null);
  const [copied, setCopied] = useState(false);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the form's webhook targets from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listTargets(inboxId, form.publicId, request.signal).then(
      (all) => setTargets(all.filter(isWebhook)),
      () => {
        if (!request.signal.aborted) setFailed(true);
      },
    );
    return () => request.abort();
  }, [inboxId, form.publicId]);

  function replace(target: Webhook) {
    setTargets(
      (current) => current?.map((item) => (item.id === target.id ? target : item)) ?? null,
    );
  }

  function show(next: IssuedSecret) {
    setIssued(next);
    setCopied(false);
  }

  const [addProblem, add, adding] = useActionState((_: string | null, data: FormData) => {
    const url = data.get("url")?.toString() ?? "";
    return attempt(async () => {
      const next = await createWebhook(inboxId, form.publicId, url);
      setTargets((current) => [...(current ?? []), next.target]);
      show(next);
    }, "Le webhook n’a pas pu être ajouté. Réessayez.");
  }, null);

  const [actionProblem, act, acting] = useActionState((_: string | null, data: FormData) => {
    const target = targets?.find(({ id }) => id === data.get("target"));
    const action = data.get("action");
    if (target === undefined) return null;
    return attempt(async () => {
      if (action === "rotate") {
        const next = await rotateSecret(inboxId, target.id);
        replace(next.target);
        show(next);
      } else if (action === "activate" || action === "deactivate") {
        const next = await setTargetActive(inboxId, target.id, action);
        if (isWebhook(next)) replace(next);
      }
    }, "La modification n’a pas pu être enregistrée. Réessayez.");
  }, null);

  return (
    <Card aria-label={`Webhooks du formulaire ${form.name}`}>
      <CardHeader>
        <CardTitle>Webhooks</CardTitle>
        <CardDescription>
          Chaque message accepté est envoyé en POST à ces adresses, signé avec le secret du webhook.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {failed && <FormProblem>Impossible de charger les webhooks.</FormProblem>}
        {targets === null && !failed && (
          <output className="text-sm text-muted-foreground">Chargement des webhooks…</output>
        )}
        {targets?.length === 0 && (
          <p className="text-sm text-muted-foreground">Aucun webhook pour ce formulaire.</p>
        )}
        {targets !== null && targets.length > 0 && (
          <ul className="grid gap-px overflow-hidden rounded-md bg-border shadow-raised">
            {targets.map((target) => (
              <li key={target.id} className="grid gap-2 bg-card px-3 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <code className="min-w-0 flex-1 basis-56 font-mono text-sm wrap-anywhere">
                    {target.url}
                  </code>
                  <Badge variant={target.active ? "success" : "neutral"}>
                    {target.active ? "Actif" : "Désactivé"}
                  </Badge>
                </div>
                {target.previousSecretExpiresAt !== null && (
                  <p className="text-xs text-pretty text-muted-foreground tabular-nums">
                    L’ancien secret signe aussi les envois jusqu’au{" "}
                    {date.format(target.previousSecretExpiresAt)}.
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <TargetTest inboxId={inboxId} targetId={target.id} />
                  <form action={act} className="contents">
                    <input type="hidden" name="target" value={target.id} />
                    <Button type="submit" size="sm" name="action" value="rotate" disabled={acting}>
                      Renouveler le secret
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      variant="ghost"
                      name="action"
                      value={target.active ? "deactivate" : "activate"}
                      disabled={acting}
                    >
                      {target.active ? "Désactiver" : "Réactiver"}
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
        <FormProblem>{actionProblem}</FormProblem>
        {issued !== null && (
          <Alert>
            <AlertTitle>Secret de signature</AlertTitle>
            <AlertDescription>
              <p>
                Secret de <code className="font-mono wrap-anywhere">{issued.target.url}</code>. Il
                ne sera plus affiché : copiez-le maintenant dans la configuration du destinataire.
              </p>
              <code className="rounded-md bg-card px-3 py-2 font-mono text-sm wrap-anywhere">
                {issued.secret}
              </code>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(issued.secret).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Secret copié" : "Copier le secret"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
                  Masquer
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        <form action={add} className="grid gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <TextField
              label="URL du webhook"
              className="min-w-0 flex-1 basis-64"
              type="url"
              name="url"
              required
              maxLength={2048}
              placeholder="https://"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={adding}>
              Ajouter le webhook
            </Button>
          </div>
          <FormProblem>{addProblem}</FormProblem>
        </form>
      </CardContent>
    </Card>
  );
}
