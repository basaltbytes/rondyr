import { Option, Schema } from "effect";
import { useActionState, useEffect, useState } from "react";

import type { Inbox } from "~/lib/inbox-client";
import { addOrigin, listOrigins, OriginRequestFailed, removeOrigin } from "~/lib/origins-client";
import type { AllowedOrigin } from "~/lib/origins-client";

import { originRefusals } from "./strings.ts";

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
      onSome: (problem) => originRefusals[problem.reason],
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
    <section aria-label={`Origines autorisées du formulaire ${form.name}`}>
      <h3>{form.name}</h3>
      <p>Une liste vide autorise tous les sites à envoyer ce formulaire depuis un navigateur.</p>
      {failed && <p role="alert">Impossible de charger les origines autorisées.</p>}
      {origins === null && !failed && <output>Chargement des origines…</output>}
      {origins?.length === 0 && <p>Aucune origine.</p>}
      {origins !== null && origins.length > 0 && (
        <ul>
          {origins.map((item) => (
            <li key={item.origin}>
              <form action={remove} className="inbox-actions">
                <code>{item.origin}</code>
                <input type="hidden" name="origin" value={item.origin} />
                <button type="submit" disabled={removing}>
                  Retirer
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {removeProblem !== null && <p role="alert">{removeProblem}</p>}
      <form action={add} className="inbox-actions">
        <label>
          Origine{" "}
          <input
            type="url"
            name="origin"
            required
            maxLength={2048}
            placeholder="https://www.example.com"
          />
        </label>
        <button type="submit" disabled={adding}>
          Ajouter
        </button>
      </form>
      {addProblem !== null && <p role="alert">{addProblem}</p>}
    </section>
  );
}
