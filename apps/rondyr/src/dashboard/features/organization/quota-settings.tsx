import { useMutation, useQuery } from "@tanstack/react-query";
import { useActionState, useId } from "react";
import { useTranslation } from "react-i18next";

import {
  maxDailyClassifications,
  maxDailySubmissions,
} from "@rondyr/organizations/organization-quotas";

import { CardFormSkeleton } from "~/components/page-pending";
import { ReadFailure } from "~/components/read-failure";
import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "~/components/ui/card";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { quotasQuery, saveQuotasMutation, type DailyUsage } from "~/lib/api/quotas";

interface QuotaFormProps {
  readonly organizationId: string;
  readonly usage: DailyUsage;
}

function QuotaForm({ organizationId, usage }: QuotaFormProps) {
  const { t, i18n } = useTranslation();
  const { mutateAsync: saveQuotas } = useMutation(saveQuotasMutation(organizationId));
  const [result, save, saving] = useActionState(
    async (_: "saved" | "saveFailed" | null, data: FormData) => {
      try {
        await saveQuotas({
          submissions: Number(data.get("submissions")),
          classifications: Number(data.get("classifications")),
        });
        return "saved";
      } catch {
        return "saveFailed";
      }
    },
    null,
  );
  const number = new Intl.NumberFormat(i18n.language);
  const junkId = useId();

  return (
    <form action={save} className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t("inbox.quotas.day", { day: usage.day })}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          key={`submissions:${usage.limits.submissions}`}
          label={t("inbox.quotas.submissions")}
          hint={t("inbox.quotas.used", {
            used: number.format(usage.used.submissions),
            limit: number.format(usage.limits.submissions),
          })}
          name="submissions"
          type="number"
          inputMode="numeric"
          min={1}
          max={maxDailySubmissions}
          defaultValue={usage.limits.submissions}
          readOnly={saving}
          required
        />
        <TextField
          key={`classifications:${usage.limits.classifications}`}
          label={t("inbox.quotas.classifications")}
          hint={t("inbox.quotas.used", {
            used: number.format(usage.used.classifications),
            limit: number.format(usage.limits.classifications),
          })}
          name="classifications"
          type="number"
          inputMode="numeric"
          min={0}
          max={maxDailyClassifications}
          defaultValue={usage.limits.classifications}
          readOnly={saving}
          required
        />
      </div>
      <section aria-labelledby={junkId} className="grid gap-1.5">
        <h2 id={junkId} className="text-sm leading-none font-medium">
          {t("inbox.quotas.junk")}
        </h2>
        <p className="text-xs text-pretty text-muted-foreground">
          {t("inbox.quotas.used", {
            used: number.format(usage.used.junk),
            limit: number.format(usage.limits.submissions),
          })}
        </p>
        <p className="text-xs text-pretty text-muted-foreground">{t("inbox.quotas.junkHint")}</p>
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? t("inbox.quotas.saving") : t("common.save")}
        </Button>
        <output className="text-sm text-muted-foreground">
          {result === "saved" && !saving ? t("inbox.quotas.saved") : null}
        </output>
      </div>
      <FormProblem>{result === "saveFailed" ? t("inbox.quotas.saveFailed") : null}</FormProblem>
    </form>
  );
}

interface QuotaSettingsProps {
  readonly organizationId: string;
}

export function QuotaSettings({ organizationId }: QuotaSettingsProps) {
  const { t } = useTranslation();
  const usage = useQuery(quotasQuery(organizationId));
  return (
    <main className="min-w-0 lg:col-span-2 lg:overflow-y-auto">
      <header className="flex h-14 items-center gap-2 px-1">
        <SidebarTrigger />
        <h1 className="truncate text-base font-semibold">{t("inbox.sections.quotas")}</h1>
      </header>
      <div className="mx-auto max-w-xl px-5 pb-8">
        <Card>
          <CardHeader>
            <CardDescription>{t("inbox.quotas.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            {usage.isError && (
              <ReadFailure
                cause={usage.error}
                title={t("inbox.quotas.loadFailed")}
                retry={t("inbox.quotas.retry")}
                retrying={usage.isFetching}
                onRetry={() => void usage.refetch()}
              />
            )}
            {usage.isPending && <CardFormSkeleton label={t("common.loading")} />}
            {usage.isSuccess && <QuotaForm organizationId={organizationId} usage={usage.data} />}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
