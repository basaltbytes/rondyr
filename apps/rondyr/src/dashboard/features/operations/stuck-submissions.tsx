import { useMutation, useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { ReadFailure } from "~/components/read-failure";
import { Button } from "~/components/ui/button";
import { retryStuckMutation, stuckSubmissionsQuery } from "~/lib/api/operations";
import { useFormats } from "~/lib/i18n";

interface StuckSubmissionsProps {
  readonly organizationId: string;
}

/**
 * The submissions of an organization that the Cron stopped publishing, oldest
 * first, each with its form, its time of arrival and a Retry button. No field
 * of a message appears here: the inbox shows it.
 */
export function StuckSubmissions({ organizationId }: StuckSubmissionsProps) {
  const { t } = useTranslation();
  const format = useFormats();
  const query = useQuery(stuckSubmissionsQuery(organizationId));
  const stuck = query.isError ? null : (query.data ?? null);
  const { mutateAsync: retryStuck } = useMutation(retryStuckMutation(organizationId));

  const [retryFailed, retry, retrying] = useActionState(
    async (_: boolean, form: FormData): Promise<boolean> => {
      const submission = stuck?.submissions.find(
        ({ submissionId }) => submissionId === form.get("submission"),
      );
      if (submission === undefined) return false;
      try {
        // Already retried, or handed off since: the new status shows it.
        await retryStuck(submission.submissionId);
        return false;
      } catch {
        return true;
      }
    },
    false,
  );

  return (
    <section aria-label={t("operations.stuck.title")} className="grid gap-2 text-sm">
      <h4 className="font-medium">{t("operations.stuck.title")}</h4>
      <p className="text-pretty text-muted-foreground">{t("operations.stuck.description")}</p>
      {query.isError && (
        <ReadFailure
          cause={query.error}
          title={t("operations.stuck.loadFailed")}
          retry={t("common.retry")}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.isPending && (
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
