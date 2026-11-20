import { useActionState, useEffect, useState } from "react";

import { FormProblem, TextAreaField } from "~/components/text-field";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
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
import { TargetTest } from "./target-test.tsx";

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
    <Card aria-label={`Destinations e-mail du formulaire ${form.name}`}>
      <CardHeader>
        <CardTitle>E-mails</CardTitle>
        <CardDescription>
          Chaque message accepté est envoyé en texte brut aux destinataires de chaque destination.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {failed && <FormProblem>Impossible de charger les destinations e-mail.</FormProblem>}
        {targets === null && !failed && (
          <output className="text-sm text-muted-foreground">
            Chargement des destinations e-mail…
          </output>
        )}
        {targets?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Aucune destination e-mail pour ce formulaire.
          </p>
        )}
        {targets !== null && targets.length > 0 && (
          <ul className="grid gap-px overflow-hidden rounded-md bg-border shadow-raised">
            {targets.map((target) => (
              <li key={target.id} className="grid gap-2 bg-card px-3 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="min-w-0 flex-1 basis-56 text-sm wrap-anywhere">
                    {target.recipients.join(", ")}
                  </p>
                  <Badge variant={target.active ? "success" : "neutral"}>
                    {target.active ? "Active" : "Désactivée"}
                  </Badge>
                </div>
                {editing === target.id ? (
                  <form action={act} className="grid gap-3">
                    <input type="hidden" name="target" value={target.id} />
                    <TextAreaField
                      label="Destinataires, un par ligne"
                      name="recipients"
                      required
                      rows={3}
                      defaultValue={target.recipients.join("\n")}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        variant="default"
                        name="action"
                        value="save"
                        disabled={acting}
                      >
                        Enregistrer
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Annuler
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <TargetTest inboxId={inboxId} targetId={target.id} />
                    <Button size="sm" onClick={() => setEditing(target.id)}>
                      Modifier les destinataires
                    </Button>
                    <form action={act} className="contents">
                      <input type="hidden" name="target" value={target.id} />
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
                )}
              </li>
            ))}
          </ul>
        )}
        <FormProblem>{actionProblem}</FormProblem>
        <form action={add} className="grid gap-3">
          <TextAreaField
            label="Destinataires, un par ligne"
            name="recipients"
            required
            rows={3}
            placeholder="equipe@example.com"
            autoComplete="off"
            spellCheck={false}
          />
          <FormProblem>{addProblem}</FormProblem>
          <Button type="submit" className="justify-self-start" disabled={adding}>
            Ajouter la destination
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
