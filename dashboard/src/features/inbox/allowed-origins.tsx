import { Option, Schema } from "effect";
import { useActionState, useEffect, useState } from "react";

import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import type { Inbox } from "~/lib/inbox-client";
import { addOrigin, listOrigins, OriginRequestFailed, removeOrigin } from "~/lib/origins-client";
import type { AllowedOrigin } from "~/lib/origins-client";

import { originInUse, originRefusals } from "./strings.ts";

const isFailed = Schema.is(OriginRequestFailed);

/** Run a request and return the message to show if it fails, or null. */
async function attempt(request: () => Promise<void>, fallback: string) {
  try {
    await request();
    return null;
  } catch (error) {
    if (!isFailed(error)) return fallback;
    return Option.match(error.problem, {
      onNone: () => fallback,
      onSome: (problem) =>
        problem.error === "origin-in-use" ? originInUse : originRefusals[problem.reason],
    });
  }
}

interface AllowedOriginsProps {
  readonly inboxId: Inbox["id"];
  readonly form: Inbox["forms"][number];
}

export function AllowedOrigins({ inboxId, form }: AllowedOriginsProps) {
  const [origins, setOrigins] = useState<readonly AllowedOrigin[] | null>(null);
  const [failed, setFailed] = useState(false);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the form's allowed origins from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listOrigins(inboxId, form.publicId, request.signal).then(setOrigins, () => {
      if (!request.signal.aborted) setFailed(true);
    });
    return () => request.abort();
  }, [inboxId, form.publicId]);

  const [addProblem, add, adding] = useActionState((_: string | null, data: FormData) => {
    const origin = data.get("origin")?.toString() ?? "";
    return attempt(async () => {
      const added = await addOrigin(inboxId, form.publicId, origin);
      setOrigins((current) => {
        const kept = current ?? [];
        return kept.some((item) => item.origin === added.origin) ? kept : [...kept, added];
      });
    }, "L’origine n’a pas pu être ajoutée. Réessayez.");
  }, null);

  const [removeProblem, remove, removing] = useActionState((_: string | null, data: FormData) => {
    const origin = data.get("origin")?.toString() ?? "";
    return attempt(async () => {
      await removeOrigin(inboxId, form.publicId, origin);
      setOrigins((current) => current?.filter((item) => item.origin !== origin) ?? null);
    }, "L’origine n’a pas pu être retirée. Réessayez.");
  }, null);

  return (
    <Card aria-label={`Origines autorisées du formulaire ${form.name}`}>
      <CardHeader>
        <CardTitle>Origines autorisées</CardTitle>
        <CardDescription>
          Les sites dont les pages peuvent envoyer ce formulaire depuis un navigateur. Une liste
          vide autorise tous les sites.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {failed && <FormProblem>Impossible de charger les origines autorisées.</FormProblem>}
        {origins === null && !failed && (
          <output className="text-sm text-muted-foreground">Chargement des origines…</output>
        )}
        {origins?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Aucune origine : tous les sites sont autorisés.
          </p>
        )}
        {origins !== null && origins.length > 0 && (
          <ul className="grid gap-px overflow-hidden rounded-md bg-border shadow-raised">
            {origins.map((item) => (
              <li key={item.origin} className="bg-card py-1 pr-1 pl-3">
                <form action={remove} className="flex items-center gap-3">
                  <code className="min-w-0 flex-1 font-mono text-sm wrap-anywhere">
                    {item.origin}
                  </code>
                  <input type="hidden" name="origin" value={item.origin} />
                  <Button type="submit" variant="ghost" disabled={removing}>
                    Retirer
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <FormProblem>{removeProblem}</FormProblem>
        <form action={add} className="grid gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <TextField
              label="Origine"
              className="min-w-0 flex-1 basis-64"
              type="url"
              name="origin"
              required
              maxLength={2048}
              placeholder="https://www.example.com"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={adding}>
              Ajouter l’origine
            </Button>
          </div>
          <FormProblem>{addProblem}</FormProblem>
        </form>
      </CardContent>
    </Card>
  );
}
