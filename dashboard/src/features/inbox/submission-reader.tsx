import { Schema } from "effect";
import { useActionState, useEffect, useState } from "react";

import { getSubmission, InboxRequestError, reviewSubmission } from "~/lib/inbox-client";
import type { Inbox, Submission } from "~/lib/inbox-client";

import { statusLabels, reviewReasons } from "./strings.ts";

interface SubmissionReaderProps {
  readonly inboxId: Inbox["id"];
  readonly submissionId: Submission["submissionId"];
  readonly revision: number;
  readonly onReview: () => void;
}

const isRequestError = Schema.is(InboxRequestError);

export function SubmissionReader({
  inboxId,
  submissionId,
  revision,
  onReview,
}: SubmissionReaderProps) {
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [failed, setFailed] = useState(false);
  const [problem, decide, pending] = useActionState(async (_: string | null, form: FormData) => {
    const decision = form.get("decision");
    if (decision !== "approve" && decision !== "dismiss") return null;
    try {
      setSubmission(await reviewSubmission(inboxId, submissionId, decision));
      onReview();
      return null;
    } catch (error) {
      if (isRequestError(error) && error.status === 409) {
        try {
          setSubmission(await getSubmission(inboxId, submissionId, new AbortController().signal));
        } catch {
          setFailed(true);
        }
        onReview();
        return "Ce message a déjà été traité.";
      }
      return "La décision n’a pas pu être enregistrée. Réessayez.";
    }
  }, null);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the selected submission from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void getSubmission(inboxId, submissionId, request.signal).then(setSubmission, () => {
      if (!request.signal.aborted) setFailed(true);
    });
    return () => request.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Reloads the selected message when the inbox refreshes.
  }, [inboxId, submissionId, revision]);

  if (failed) return <p role="alert">Impossible de lire le message.</p>;
  if (submission === null) return <output>Chargement du message…</output>;

  return (
    <section className="submission-reader" aria-label="Message sélectionné">
      <h3>{submission.formName}</h3>
      <p>
        {statusLabels[submission.status]}
        {submission.reason === null ? "" : ` · ${reviewReasons[submission.reason]}`}
      </p>
      <dl>
        {Object.entries(submission.fields).map(([field, value]) => (
          <div key={field}>
            <dt>{field}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {problem !== null && <output>{problem}</output>}
      {submission.status === "quarantined" && (
        <form action={decide} className="inbox-actions">
          <button type="submit" name="decision" value="approve" disabled={pending}>
            Accepter le message
          </button>
          <button type="submit" name="decision" value="dismiss" disabled={pending}>
            Archiver
          </button>
        </form>
      )}
    </section>
  );
}
