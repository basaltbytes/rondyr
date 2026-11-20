import { cn } from "cn";
import { Schema } from "effect";
import { Archive, Check, ChevronLeft } from "lucide-react";
import { useActionState } from "react";

import { Button } from "~/components/ui/button";
import { getSubmission, InboxRequestError, reviewSubmission } from "~/lib/inbox-client";
import type { Inbox, Submission } from "~/lib/inbox-client";
import { reviewReasons } from "~/lib/status-labels";

import { DeliveryHistory } from "./delivery-history.tsx";
import { fullTime, readMessage } from "./message-preview.ts";
import { statusLabels } from "./strings.ts";

// Color is the status of the message, and nothing else in the reader has one.
const statusTones = {
  received: "text-muted-foreground",
  classifying: "text-muted-foreground",
  accepted: "text-success",
  quarantined: "text-warning",
  archived: "text-muted-foreground",
} as const;

const isRequestError = Schema.is(InboxRequestError);

interface SubmissionReaderProps {
  readonly inboxId: Inbox["id"];
  readonly submission: Submission;
  readonly revision: number;
  /** The message as the API returns it once it is accepted or archived. */
  readonly onReviewed: (submission: Submission) => void;
  readonly onClose: () => void;
}

/**
 * One message. The bar on top has the decision, at the height of the list's
 * header. Under it everything starts on one left edge: why the message is
 * here, who wrote, what they wrote, then the other fields.
 */
export function SubmissionReader({
  inboxId,
  submission,
  revision,
  onReviewed,
  onClose,
}: SubmissionReaderProps) {
  const { submissionId } = submission;
  const [problem, decide, pending] = useActionState(async (_: string | null, form: FormData) => {
    const decision = form.get("decision");
    if (decision !== "approve" && decision !== "dismiss") return null;
    try {
      onReviewed(await reviewSubmission(inboxId, submissionId, decision));
      return null;
    } catch (error) {
      if (!isRequestError(error) || error.status !== 409) {
        return "La décision n’a pas pu être enregistrée. Réessayez.";
      }
      try {
        onReviewed(await getSubmission(inboxId, submissionId, new AbortController().signal));
      } catch {
        return "Ce message a déjà été traité. Actualisez la liste pour voir son statut.";
      }
      return "Ce message a déjà été traité.";
    }
  }, null);

  const { sender, subject, body, details } = readMessage(submission.fields);
  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 hairline-b pr-5 pl-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Retour à la liste"
          className="lg:hidden"
          onClick={onClose}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </Button>
        {submission.status === "quarantined" && (
          <form action={decide} className="ml-auto flex gap-2">
            <Button type="submit" name="decision" value="dismiss" disabled={pending}>
              <Archive aria-hidden="true" className="size-4" />
              Archiver
            </Button>
            <Button
              type="submit"
              variant="default"
              name="decision"
              value="approve"
              disabled={pending}
            >
              <Check aria-hidden="true" className="size-4" />
              <span>
                Accepter<span className="max-sm:hidden"> et envoyer</span>
              </span>
            </Button>
          </form>
        )}
      </header>
      <div className="min-h-0 flex-1 lg:overflow-y-auto">
        <article className="grid max-w-3xl gap-6 px-5 pt-6 pb-10">
          <header className="grid gap-2">
            <p className={cn("text-sm font-medium", statusTones[submission.status])}>
              {submission.reason === null
                ? statusLabels[submission.status]
                : reviewReasons[submission.reason]}
            </p>
            <div>
              <h2 className="text-xl/snug font-semibold wrap-anywhere">
                {sender.label ?? "Expéditeur inconnu"}
              </h2>
              {sender.name !== null && sender.email !== null && (
                <p className="text-sm wrap-anywhere text-muted-foreground">{sender.email}</p>
              )}
            </div>
            <p className="text-xs wrap-anywhere text-muted-foreground">
              {submission.formName} ·{" "}
              <time
                dateTime={new Date(submission.receivedAt).toISOString()}
                className="tabular-nums"
              >
                {fullTime(submission.receivedAt)}
              </time>
            </p>
          </header>
          {problem !== null && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          {(submission.status === "received" || submission.status === "classifying") && (
            <p className="text-sm text-muted-foreground">
              Le filtre analyse ce message. Actualisez la liste pour voir son classement.
            </p>
          )}
          {(subject !== null || body !== null) && (
            <div className="grid max-w-prose gap-2">
              {subject !== null && (
                <h3 className="text-base font-semibold wrap-anywhere">{subject}</h3>
              )}
              {body !== null && (
                <p className="text-base/relaxed wrap-anywhere whitespace-pre-wrap">{body}</p>
              )}
            </div>
          )}
          {details.length > 0 && (
            <dl className="grid field-grid gap-x-6 gap-y-2 hairline-t pt-5 text-sm">
              {details.map(([name, value]) => (
                <div key={name} className="col-span-2 grid grid-cols-subgrid">
                  <dt className="font-mono text-xs leading-5 wrap-anywhere text-muted-foreground">
                    {name}
                  </dt>
                  <dd className="wrap-anywhere whitespace-pre-wrap">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {submission.status === "accepted" && (
            <DeliveryHistory inboxId={inboxId} submissionId={submissionId} revision={revision} />
          )}
        </article>
      </div>
    </>
  );
}
