import { use, useActionState } from "react";
import { useTranslation } from "react-i18next";

import { maxRetentionDays } from "@rondyr/organizations/retention";

import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { SidebarTrigger } from "~/components/ui/sidebar";
import type { Inbox } from "~/lib/inbox-client";
import { saveRetention } from "~/lib/retention-client";
import type { Retention } from "~/lib/retention-client";

/** Whole days from 1 to the maximum, or an empty field to keep the messages. */
function daysIn(data: FormData, name: string): number | null | "invalid" {
  const text = data.get(name)?.toString().trim() ?? "";
  if (text === "") return null;
  const days = Number(text);
  return Number.isInteger(days) && days >= 1 && days <= maxRetentionDays ? days : "invalid";
}

type Outcome = "saved" | "invalid" | "failed";

function RetentionForm({ inboxId, initial }: { inboxId: Inbox["id"]; initial: Retention }) {
  const { t } = useTranslation();
  const [state, save, saving] = useActionState(
    async (
      previous: { periods: Retention; outcome: Outcome | null },
      data: FormData,
    ): Promise<{ periods: Retention; outcome: Outcome | null }> => {
      const accepted = daysIn(data, "accepted");
      const quarantine = daysIn(data, "quarantine");
      if (accepted === "invalid" || quarantine === "invalid") {
        return { ...previous, outcome: "invalid" };
      }
      try {
        const periods = await saveRetention(inboxId, { accepted, quarantine });
        return { periods, outcome: "saved" };
      } catch {
        return { ...previous, outcome: "failed" };
      }
    },
    { periods: initial, outcome: null },
  );

  return (
    <form action={save} className="grid gap-4">
      <TextField
        label={t("inbox.retention.accepted")}
        hint={t("inbox.retention.hint", { maximum: maxRetentionDays })}
        name="accepted"
        type="number"
        inputMode="numeric"
        min={1}
        max={maxRetentionDays}
        step={1}
        defaultValue={state.periods.accepted ?? ""}
        placeholder={t("inbox.retention.unlimited")}
      />
      <TextField
        label={t("inbox.retention.quarantine")}
        hint={t("inbox.retention.hint", { maximum: maxRetentionDays })}
        name="quarantine"
        type="number"
        inputMode="numeric"
        min={1}
        max={maxRetentionDays}
        step={1}
        defaultValue={state.periods.quarantine ?? ""}
        placeholder={t("inbox.retention.unlimited")}
      />
      <FormProblem>
        {state.outcome === "invalid" || state.outcome === "failed"
          ? t(`inbox.retention.outcomes.${state.outcome}`)
          : null}
      </FormProblem>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="default" disabled={saving}>
          {saving ? t("inbox.retention.saving") : t("common.save")}
        </Button>
        <output className="text-sm text-muted-foreground">
          {state.outcome === "saved" ? t("inbox.retention.outcomes.saved") : null}
        </output>
      </div>
    </form>
  );
}

interface RetentionSettingsProps {
  readonly inboxId: Inbox["id"];
  readonly retention: Promise<Retention | null>;
  readonly onRetry: () => void;
}

/** How long the organization keeps its messages, which a purge deletes once an hour. */
export function RetentionSettings({ inboxId, retention, onRetry }: RetentionSettingsProps) {
  const { t } = useTranslation();
  const initial = use(retention);
  return (
    <main className="min-w-0 lg:col-span-2 lg:overflow-y-auto">
      <header className="flex h-14 items-center gap-2 px-1">
        <SidebarTrigger />
        <h1 className="truncate text-base font-semibold">{t("inbox.sections.retention")}</h1>
      </header>
      <div className="mx-auto max-w-xl px-5 pb-8">
        <Card>
          <CardHeader>
            <CardTitle>{t("inbox.retention.title")}</CardTitle>
            <CardDescription>{t("inbox.retention.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            {initial === null ? (
              <div className="grid justify-items-start gap-2">
                <FormProblem>{t("inbox.retention.loadFailed")}</FormProblem>
                <Button onClick={onRetry}>{t("inbox.retention.retry")}</Button>
              </div>
            ) : (
              <RetentionForm inboxId={inboxId} initial={initial} />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
