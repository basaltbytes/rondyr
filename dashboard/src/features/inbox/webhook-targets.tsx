import { useActionState, useEffect, useState } from "react";

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
    <section aria-label={`Webhooks du formulaire ${form.name}`}>
      <h3>{form.name}</h3>
      {failed && <p role="alert">Impossible de charger les webhooks.</p>}
      {targets === null && !failed && <output>Chargement des webhooks…</output>}
      {targets?.length === 0 && <p>Aucun webhook.</p>}
      {targets !== null && targets.length > 0 && (
        <ul>
          {targets.map((target) => (
            <li key={target.id}>
              <code>{target.url}</code> · {target.active ? "Actif" : "Désactivé"}
              {target.previousSecretExpiresAt !== null &&
                ` · l’ancien secret signe aussi les envois jusqu’au ${date.format(target.previousSecretExpiresAt)}`}
              <form action={act} className="inbox-actions">
                <input type="hidden" name="target" value={target.id} />
                <button type="submit" name="action" value="rotate" disabled={acting}>
                  Renouveler le secret
                </button>
                <button
                  type="submit"
                  name="action"
                  value={target.active ? "deactivate" : "activate"}
                  disabled={acting}
                >
                  {target.active ? "Désactiver" : "Réactiver"}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {actionProblem !== null && <p role="alert">{actionProblem}</p>}
      {issued !== null && (
        <div>
          <p>
            Secret de signature de <code>{issued.target.url}</code>. Il ne sera plus affiché :
            copiez-le maintenant dans la configuration du destinataire.
          </p>
          <code>{issued.secret}</code>
          <div className="inbox-actions">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(issued.secret).then(() => setCopied(true));
              }}
            >
              {copied ? "Copié" : "Copier le secret"}
            </button>
            <button type="button" onClick={() => setIssued(null)}>
              Masquer
            </button>
          </div>
        </div>
      )}
      <form action={add} className="inbox-actions">
        <label>
          URL du webhook{" "}
          <input type="url" name="url" required maxLength={2048} placeholder="https://" />
        </label>
        <button type="submit" disabled={adding}>
          Ajouter
        </button>
      </form>
      {addProblem !== null && <p role="alert">{addProblem}</p>}
    </section>
  );
}
