import { useActionState, useEffect, useState } from "react";

import { createInbox, listInboxes, listSubmissions } from "~/lib/inbox-client";
import type { Inbox, Page, Status, Submission } from "~/lib/inbox-client";

import { AllowedOrigins } from "./allowed-origins.tsx";
import { EmailTargets } from "./email-targets.tsx";
import { statusLabels } from "./strings.ts";
import { SubmissionReader } from "./submission-reader.tsx";
import { WebhookTargets } from "./webhook-targets.tsx";

const date = new Intl.DateTimeFormat("fr", { dateStyle: "short", timeStyle: "short" });

interface InboxSetupProps {
  readonly onCreated: () => void;
}

function InboxSetup({ onCreated }: InboxSetupProps) {
  const [error, action, pending] = useActionState(async (_: string | null, form: FormData) => {
    try {
      await createInbox(form);
      onCreated();
      return null;
    } catch {
      return "La boîte n’a pas pu être créée. Vérifiez les champs et réessayez.";
    }
  }, null);
  return (
    <form className="auth-form" action={action}>
      <label>
        Organisation <input name="organizationName" required maxLength={100} />
      </label>
      <label>
        Nom du formulaire <input name="formName" required maxLength={100} />
      </label>
      <label>
        Activité de l’organisation{" "}
        <textarea name="businessContext" maxLength={2000} placeholder="Facultatif" />
      </label>
      {error !== null && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>
        Créer une boîte de réception
      </button>
    </form>
  );
}

interface InboxViewProps {
  readonly inbox: Inbox;
}

function InboxView({ inbox }: InboxViewProps) {
  const [status, setStatus] = useState<Status | "">("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [selected, setSelected] = useState<Submission["submissionId"] | null>(null);
  const [failed, setFailed] = useState(false);
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  const [emailsOpen, setEmailsOpen] = useState(false);
  const [originsOpen, setOriginsOpen] = useState(false);

  function refresh() {
    setFailed(false);
    setRevision((value) => value + 1);
  }

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Synchronizes the inbox with the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listSubmissions(inbox.id, status, cursor, request.signal).then(setPage, () => {
      if (!request.signal.aborted) setFailed(true);
    });
    return () => request.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The refresh event initiates a new API request.
  }, [inbox.id, status, cursor, revision]);

  return (
    <>
      {inbox.forms.length > 0 && (
        <details>
          <summary>Adresses des formulaires</summary>
          <ul>
            {inbox.forms.map((form) => (
              <li key={form.publicId}>
                {form.name}{" "}
                <code>{`${window.location.origin}/f/${encodeURIComponent(form.publicId)}`}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {inbox.forms.length > 0 && (
        <details onToggle={(event) => setWebhooksOpen(event.currentTarget.open)}>
          <summary>Webhooks</summary>
          {webhooksOpen &&
            inbox.forms.map((form) => (
              <WebhookTargets key={form.publicId} inboxId={inbox.id} form={form} />
            ))}
        </details>
      )}
      {inbox.forms.length > 0 && (
        <details onToggle={(event) => setEmailsOpen(event.currentTarget.open)}>
          <summary>E-mails</summary>
          {emailsOpen &&
            inbox.forms.map((form) => (
              <EmailTargets key={form.publicId} inboxId={inbox.id} form={form} />
            ))}
        </details>
      )}
      {inbox.forms.length > 0 && (
        <details onToggle={(event) => setOriginsOpen(event.currentTarget.open)}>
          <summary>Origines autorisées</summary>
          {originsOpen &&
            inbox.forms.map((form) => (
              <AllowedOrigins key={form.publicId} inboxId={inbox.id} form={form} />
            ))}
        </details>
      )}
      <div className="inbox-actions">
        <label>
          Statut{" "}
          <select
            value={status}
            onChange={(event) => {
              const next = Object.keys(statusLabels).find(
                (value): value is Status =>
                  Object.hasOwn(statusLabels, value) && value === event.target.value,
              );
              setStatus(next ?? "");
              setPage(null);
              setCursor(null);
              refresh();
            }}
          >
            <option value="">Tous les messages</option>
            {Object.entries(statusLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={refresh}>
          Actualiser
        </button>
      </div>
      <div className="inbox-columns">
        <div>
          {failed && <p role="alert">Impossible de charger les messages.</p>}
          {page === null && !failed && <output>Chargement des messages…</output>}
          {page?.entries.length === 0 && <p>Aucun message.</p>}
          {page !== null && page.entries.length > 0 && (
            <ul className="submission-list">
              {page.entries.map((row) => (
                <li key={row.submissionId}>
                  <button
                    type="button"
                    aria-pressed={row.submissionId === selected}
                    onClick={() => setSelected(row.submissionId)}
                  >
                    <strong>{row.formName}</strong>
                    <span>
                      {date.format(row.receivedAt)} · {statusLabels[row.status]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="inbox-actions">
            {cursor !== null && (
              <button
                type="button"
                onClick={() => {
                  setPage(null);
                  setCursor(null);
                }}
              >
                Première page
              </button>
            )}
            {page?.cursor != null && (
              <button
                type="button"
                onClick={() => {
                  setCursor(page.cursor);
                  setPage(null);
                }}
              >
                Page suivante
              </button>
            )}
          </div>
        </div>
        {selected !== null && (
          <SubmissionReader
            key={selected}
            inboxId={inbox.id}
            submissionId={selected}
            revision={revision}
            onReview={refresh}
          />
        )}
      </div>
    </>
  );
}

export function InboxPanel() {
  const [inboxes, setInboxes] = useState<readonly Inbox[] | null>(null);
  const [active, setActive] = useState("");
  const [failed, setFailed] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [revision, setRevision] = useState(0);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the signed-in user's organizations from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listInboxes(request.signal).then(setInboxes, () => {
      if (!request.signal.aborted) setFailed(true);
    });
    return () => request.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Creating a new inbox initiates a new API request.
  }, [revision]);

  const inbox = inboxes?.find(({ id }) => id === active) ?? inboxes?.[0];
  return (
    <section className="inbox">
      <h2>Boîte de réception</h2>
      {failed && <p role="alert">Impossible de charger les organisations.</p>}
      {inboxes === null && !failed && <output>Chargement des organisations…</output>}
      {inboxes !== null && (
        <>
          <div className="inbox-actions">
            {inbox !== undefined && (
              <label>
                Organisation{" "}
                <select value={inbox.id} onChange={(event) => setActive(event.target.value)}>
                  {inboxes.map(({ id, name }) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {inboxes.length > 0 && (
              <button type="button" onClick={() => setSetupOpen(!setupOpen)}>
                Nouvelle organisation
              </button>
            )}
          </div>
          {(setupOpen || inboxes.length === 0) && (
            <InboxSetup
              onCreated={() => {
                setSetupOpen(false);
                setFailed(false);
                setRevision((value) => value + 1);
              }}
            />
          )}
          {inbox !== undefined && <InboxView key={inbox.id} inbox={inbox} />}
        </>
      )}
    </section>
  );
}
