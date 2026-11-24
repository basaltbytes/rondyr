import { useMutation, useQuery } from "@tanstack/react-query";
import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { maxRetentionDays } from "@rondyr/organizations/retention";

import { CardFormSkeleton } from "~/components/page-pending";
import { ReadFailure } from "~/components/read-failure";
import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { retentionQuery, saveRetentionMutation, type RetentionPeriods } from "~/lib/api/retention";

/** Whole days from 1 to the maximum, or an empty field to keep the messages. */
function daysIn(data: FormData, name: string): number | null | "invalid" {
  const text = data.get(name)?.toString().trim() ?? "";
  if (text === "") return null;
  const days = Number(text);
  return Number.isInteger(days) && days >= 1 && days <= maxRetentionDays ? days : "invalid";
}

type Outcome = "saved" | "invalid" | "failed";

interface RetentionFormProps {
  readonly organizationId: string;
  readonly periods: RetentionPeriods;
}

function RetentionForm({ organizationId, periods }: RetentionFormProps) {
  const { t } = useTranslation();
  const { mutateAsync: saveRetention } = useMutation(saveRetentionMutation(organizationId));
  const [outcome, save, saving] = useActionState(
    async (_: Outcome | null, data: FormData): Promise<Outcome | null> => {
      const accepted = daysIn(data, "accepted");
      const quarantine = daysIn(data, "quarantine");
      if (accepted === "invalid" || quarantine === "invalid") return "invalid";
      try {
        await saveRetention({ accepted, quarantine });
        return "saved";
      } catch {
        return "failed";
      }
    },
    null,
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
        // The field shows the saved period again once the periods are read anew.
        key={`accepted:${periods.accepted ?? ""}`}
        defaultValue={periods.accepted ?? ""}
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
        key={`quarantine:${periods.quarantine ?? ""}`}
        defaultValue={periods.quarantine ?? ""}
        placeholder={t("inbox.retention.unlimited")}
      />
      <FormProblem>
        {outcome === "invalid" || outcome === "failed"
          ? t(`inbox.retention.outcomes.${outcome}`)
          : null}
      </FormProblem>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="default" disabled={saving}>
          {saving ? t("inbox.retention.saving") : t("common.save")}
        </Button>
        <output className="text-sm text-muted-foreground">
          {outcome === "saved" ? t("inbox.retention.outcomes.saved") : null}
        </output>
      </div>
    </form>
  );
}

interface RetentionSettingsProps {
  readonly organizationId: string;
}

/** How long the organization keeps its messages, which a purge deletes once an hour. */
export function RetentionSettings({ organizationId }: RetentionSettingsProps) {
  const { t } = useTranslation();
  const retention = useQuery(retentionQuery(organizationId));
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
            {retention.isError && (
              <ReadFailure
                cause={retention.error}
                title={t("inbox.retention.loadFailed")}
                retry={t("inbox.retention.retry")}
                retrying={retention.isFetching}
                onRetry={() => void retention.refetch()}
              />
            )}
            {retention.isPending && <CardFormSkeleton label={t("common.loading")} />}
            {retention.isSuccess && (
              <RetentionForm organizationId={organizationId} periods={retention.data} />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
