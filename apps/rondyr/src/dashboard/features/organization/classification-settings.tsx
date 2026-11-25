import { useMutation, useQuery } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import type { TFunction } from "i18next";
import { useActionState, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { OrganizationClassificationPolicy } from "@rondyr/organizations/organization-classification-policy";

import { CardFormSkeleton } from "~/components/page-pending";
import { ReadFailure } from "~/components/read-failure";
import { FormProblem, SelectField, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "~/components/ui/card";
import { SidebarTrigger } from "~/components/ui/sidebar";
import {
  classificationQuery,
  saveClassificationMutation,
  type OrganizationClassificationSettings,
} from "~/lib/api/classification";

const thresholdNames = ["probableSpam", "ambiguous", "solicitation", "lowRelevance"] as const;
const decodeOverride = Schema.decodeUnknownOption(OrganizationClassificationPolicy);
type Settings = OrganizationClassificationSettings;
type SaveResult = "saved" | "invalid" | "saveFailed" | null;
function modelName(t: TFunction, classifier: Settings["classifier"]) {
  return classifier === "jev" ? t("inbox.policy.models.jev") : t("inbox.policy.models.openai");
}

interface PolicyFormInput {
  thresholds?: Record<string, number>;
  offTopic?: string;
  escalation?: boolean;
}

interface PolicyFormProps {
  readonly organizationId: string;
  readonly settings: Settings;
}

function PolicyForm({ organizationId, settings }: PolicyFormProps) {
  const { t } = useTranslation();
  const { mutateAsync: saveOverride } = useMutation(saveClassificationMutation(organizationId));
  const { defaults, override, escalationClassifier } = settings;
  const [thresholdMode, setThresholdMode] = useState(
    override?.thresholds === undefined ? "defaults" : "custom",
  );
  const [offTopic, setOffTopic] = useState<string>(override?.offTopic ?? "defaults");
  // Without a second model the switch is disabled, and a save keeps the stored choice.
  const [escalation, setEscalation] = useState(override?.escalation ?? false);
  const escalationHint = useId();
  const [edited, setEdited] = useState(false);
  const initial = override?.thresholds ?? defaults.thresholds;
  const [values, setValues] = useState({
    probableSpam: String(initial.probableSpam),
    ambiguous: String(initial.ambiguous),
    solicitation: String(initial.solicitation),
    lowRelevance: String(initial.lowRelevance),
  });
  const custom = thresholdMode === "custom";
  const [result, save, saving] = useActionState(async (): Promise<SaveResult> => {
    const input: PolicyFormInput = {};
    if (custom) {
      input.thresholds = Object.fromEntries(
        thresholdNames.map((name) => [
          name,
          values[name].trim() === "" ? Number.NaN : Number(values[name]),
        ]),
      );
    }
    if (offTopic !== "defaults") input.offTopic = offTopic;
    if (escalation) input.escalation = true;
    const usesDefaults = !custom && offTopic === "defaults" && !escalation;
    const decoded = usesDefaults ? Option.none() : decodeOverride(input);
    if (!usesDefaults && Option.isNone(decoded)) return "invalid";
    try {
      await saveOverride(Option.getOrNull(decoded));
      setEdited(false);
      return "saved";
    } catch {
      return "saveFailed";
    }
  }, null);
  const invalidOrder =
    result === "invalid" && custom && Number(values.ambiguous) > Number(values.probableSpam);

  return (
    <form action={save} onChange={() => setEdited(true)} className="grid gap-4">
      <SelectField
        label={t("inbox.policy.thresholdMode")}
        value={thresholdMode}
        onChange={(event) => setThresholdMode(event.currentTarget.value)}
        disabled={saving}
      >
        <option value="defaults">{t("inbox.policy.defaults")}</option>
        <option value="custom">{t("inbox.policy.custom")}</option>
      </SelectField>
      <div className="grid gap-4 sm:grid-cols-2">
        {thresholdNames.map((name) => (
          <TextField
            key={name}
            label={t(`inbox.policy.thresholds.${name}`)}
            hint={t(`inbox.policy.hints.${name}`)}
            name={name}
            type="number"
            min={0}
            max={1}
            step="any"
            inputMode="decimal"
            value={custom ? values[name] : defaults.thresholds[name]}
            readOnly={!custom || saving}
            required={custom}
            aria-invalid={name === "ambiguous" && invalidOrder ? true : undefined}
            onChange={(event) => setValues({ ...values, [name]: event.currentTarget.value })}
          />
        ))}
      </div>
      <SelectField
        label={t("inbox.policy.offTopic")}
        value={offTopic}
        onChange={(event) => setOffTopic(event.currentTarget.value)}
        disabled={saving}
      >
        <option value="defaults">{t("inbox.policy.defaults")}</option>
        <option value="review">{t("inbox.policy.review")}</option>
        <option value="accept">{t("inbox.policy.accept")}</option>
      </SelectField>
      <div className="grid gap-1.5">
        <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm font-medium has-disabled:cursor-default pointer-coarse:min-h-11">
          <input
            type="checkbox"
            role="switch"
            className="peer sr-only"
            aria-checked={escalation}
            aria-describedby={escalationHint}
            checked={escalation}
            disabled={saving || escalationClassifier === null}
            onChange={(event) => setEscalation(event.currentTarget.checked)}
          />
          <span
            aria-hidden
            className="flex h-5 w-9 items-center rounded-full border border-muted-foreground bg-muted p-0.5 after:block after:size-3.5 after:rounded-full after:bg-muted-foreground peer-checked:border-primary peer-checked:bg-primary peer-checked:after:translate-x-4 peer-checked:after:bg-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-inset peer-disabled:opacity-50"
          />
          {t("inbox.policy.escalation")}
        </label>
        <p id={escalationHint} className="text-xs text-pretty text-muted-foreground">
          {escalationClassifier === null
            ? t("inbox.policy.escalationUnavailable")
            : t("inbox.policy.escalationHint", { model: modelName(t, escalationClassifier) })}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving} className="pointer-coarse:min-h-11">
          {saving ? t("inbox.policy.saving") : t("inbox.policy.save")}
        </Button>
        <FormProblem>
          {result === "invalid"
            ? t("inbox.policy.invalid")
            : result === "saveFailed"
              ? t("inbox.policy.saveFailed")
              : null}
        </FormProblem>
        <output className="text-sm text-muted-foreground">
          {result === "saved" && !saving && !edited ? t("inbox.policy.saved") : null}
        </output>
      </div>
    </form>
  );
}

interface ClassificationSettingsProps {
  readonly organizationId: string;
}

export function ClassificationSettings({ organizationId }: ClassificationSettingsProps) {
  const { t } = useTranslation();
  const settings = useQuery(classificationQuery(organizationId));
  return (
    <main className="min-w-0 lg:col-span-2 lg:overflow-y-auto">
      <header className="flex h-14 items-center gap-2 px-1">
        <SidebarTrigger />
        <h1 className="truncate text-base font-semibold">{t("inbox.sections.classification")}</h1>
      </header>
      <div className="mx-auto max-w-xl px-5 pb-8">
        <Card>
          {settings.isSuccess && (
            <CardHeader>
              <CardDescription>
                {t("inbox.policy.description", {
                  classifier: modelName(t, settings.data.classifier),
                })}
              </CardDescription>
            </CardHeader>
          )}
          <CardContent>
            {settings.isError && (
              <ReadFailure
                cause={settings.error}
                title={t("inbox.policy.loadFailed")}
                retry={t("inbox.policy.retry")}
                retrying={settings.isFetching}
                onRetry={() => void settings.refetch()}
              />
            )}
            {settings.isPending && <CardFormSkeleton label={t("common.loading")} />}
            {settings.isSuccess && (
              <PolicyForm organizationId={organizationId} settings={settings.data} />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
