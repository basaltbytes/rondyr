import { Schema } from "effect";
import { RotateCw } from "lucide-react";
import { useActionState, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import { useFormats } from "~/lib/i18n";
import { InboxRequestError } from "~/lib/inbox-client";
import type { Inbox } from "~/lib/inbox-client";
import { listStuck, retryStuck } from "~/lib/operations-client";
import type { Stuck } from "~/lib/operations-client";

const isRequestError = Schema.is(InboxRequestError);

interface StuckSubmissionsProps {
  readonly organizationId: Inbox["id"];
  /** Reads the status again once a retry has changed it. */
  readonly onRetried: () => void;
}

/**
 * The submissions of an organization that the Cron stopped publishing, oldest
 * first, each with its form, its time of arrival and a Retry button. No field
 * of a message appears here: the inbox shows it.
 */
export function StuckSubmissions({ organizationId, onRetried }: StuckSubmissionsProps) {
  const { t } = useTranslation();
  const format = useFormats();
  const [stuck, setStuck] = useState<Stuck | null>(null);
  const [failed, setFailed] = useState(false);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the stuck submissions of the organization from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listStuck(organizationId, request.signal).then(setStuck, () => {
      if (!request.signal.aborted) setFailed(true);
    });
    return () => request.abort();
  }, [organizationId]);

  const [retryFailed, retry, retrying] = useActionState(
    async (_: boolean, form: FormData): Promise<boolean> => {
      const submission = stuck?.submissions.find(
        ({ submissionId }) => submissionId === form.get("submission"),
      );
      if (submission === undefined) return false;
      try {
        setStuck(await retryStuck(organizationId, submission.submissionId));
      } catch (error) {
        // Already retried, or handed off since: the new status shows it.
        if (!isRequestError(error) || error.status !== 409) return true;
      }
      onRetried();
      return false;
    },
    false,
  );

  return (
    <section aria-label={t("operations.stuck.title")} className="grid gap-2 text-sm">
      <h4 className="font-medium">{t("operations.stuck.title")}</h4>
      <p className="text-pretty text-muted-foreground">{t("operations.stuck.description")}</p>
      {failed && (
        <p role="alert" className="text-destructive">
          {t("operations.stuck.loadFailed")}
        </p>
      )}
      {stuck === null && !failed && (
        <output className="text-muted-foreground">{t("operations.stuck.loading")}</output>
      )}
      {retryFailed && (
        <p role="alert" className="text-destructive">
          {t("operations.stuck.retryFailed")}
        </p>
      )}
      {stuck !== null && stuck.submissions.length > 0 && (
        <ul className="grid gap-px overflow-hidden rounded-md bg-border shadow-raised">
          {stuck.submissions.map((submission) => (
            <li
              key={submission.submissionId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-card px-3 py-2"
            >
              <div className="min-w-0 flex-1 basis-48">
                <p className="wrap-anywhere">{submission.formName}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {t("operations.stuck.received", {
                    date: format.timestamp(submission.receivedAt),
                  })}
                  {" · "}
                  <code className="font-mono">{submission.submissionId}</code>
                </p>
              </div>
              <form action={retry}>
                <input type="hidden" name="submission" value={submission.submissionId} />
                <Button type="submit" size="sm" disabled={retrying}>
                  <RotateCw aria-hidden="true" className="size-4" />
                  {t("operations.stuck.retry")}
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {stuck !== null && stuck.count > stuck.submissions.length && (
        <p className="text-muted-foreground">
          {t("operations.stuck.more", { count: stuck.count - stuck.submissions.length })}
        </p>
      )}
    </section>
  );
}
