import { useActionState, useEffect, useState } from "react";

import type { Inbox } from "~/lib/inbox-client";
import {
  createEmailTarget,
  isEmailDestination,
  listTargets,
  replaceRecipients,
  setTargetActive,
} from "~/lib/targets-client";
import type { EmailDestination } from "~/lib/targets-client";

import { attempt } from "./target-problems.ts";

/** One address per line, or separated by commas or semicolons. */
function addressesIn(data: FormData) {
  const text = data.get("recipients")?.toString() ?? "";
  return text.split(/[\s,;]+/u).filter((address) => address !== "");
}

interface EmailTargetsProps {
  readonly inboxId: Inbox["id"];
  readonly form: Inbox["forms"][number];
}

export function EmailTargets({ inboxId, form }: EmailTargetsProps) {
  const [targets, setTargets] = useState<readonly EmailDestination[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<EmailDestination["id"] | null>(null);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the form's email targets from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listTargets(inboxId, form.publicId, request.signal).then(
      (all) => setTargets(all.filter(isEmailDestination)),
      () => {
        if (!request.signal.aborted) setFailed(true);
      },
    );
    return () => request.abort();
  }, [inboxId, form.publicId]);

  function replace(target: EmailDestination) {
    setTargets(
      (current) => current?.map((item) => (item.id === target.id ? target : item)) ?? null,
    );
  }

  const [addProblem, add, adding] = useActionState((_: string | null, data: FormData) => {
    const recipients = addressesIn(data);
    return attempt(async () => {
      const created = await createEmailTarget(inboxId, form.publicId, recipients);
      setTargets((current) => [...(current ?? []), created]);
    }, "La destination e-mail n’a pas pu être ajoutée. Réessayez.");
  }, null);

  const [actionProblem, act, acting] = useActionState((_: string | null, data: FormData) => {
    const target = targets?.find(({ id }) => id === data.get("target"));
    const action = data.get("action");
    if (target === undefined) return null;
    return attempt(async () => {
      if (action === "save") {
        replace(await replaceRecipients(inboxId, target.id, addressesIn(data)));
        setEditing(null);
      } else if (action === "activate" || action === "deactivate") {
        const next = await setTargetActive(inboxId, target.id, action);
        if (isEmailDestination(next)) replace(next);
      }
    }, "La modification n’a pas pu être enregistrée. Réessayez.");
  }, null);

  return (
    <section aria-label={`Destinations e-mail du formulaire ${form.name}`}>
      <h3>{form.name}</h3>
      {failed && <p role="alert">Impossible de charger les destinations e-mail.</p>}
      {targets === null && !failed && <output>Chargement des destinations e-mail…</output>}
      {targets?.length === 0 && <p>Aucune destination e-mail.</p>}
      {targets !== null && targets.length > 0 && (
        <ul>
          {targets.map((target) => (
            <li key={target.id}>
              {target.recipients.join(", ")} · {target.active ? "Active" : "Désactivée"}
              <form action={act} className="inbox-actions">
                <input type="hidden" name="target" value={target.id} />
                {editing === target.id ? (
                  <>
                    <label>
                      Destinataires{" "}
                      <textarea
                        name="recipients"
                        required
                        rows={3}
                        defaultValue={target.recipients.join("\n")}
                      />
                    </label>
                    <button type="submit" name="action" value="save" disabled={acting}>
                      Enregistrer
                    </button>
                    <button type="button" onClick={() => setEditing(null)}>
                      Annuler
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => setEditing(target.id)}>
                    Modifier les destinataires
                  </button>
                )}
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
      <form action={add} className="inbox-actions">
        <label>
          Destinataires, un par ligne{" "}
          <textarea name="recipients" required rows={3} placeholder="equipe@example.com" />
        </label>
        <button type="submit" disabled={adding}>
          Ajouter
        </button>
      </form>
      {addProblem !== null && <p role="alert">{addProblem}</p>}
    </section>
  );
}
