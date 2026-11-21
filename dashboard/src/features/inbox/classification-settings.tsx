import { Option, Schema } from "effect";
import { use, useActionState, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  OrganizationClassificationPolicy,
  type OrganizationClassificationSettings,
} from "@rondyr/organizations/organization-classification-policy";

import { FormProblem, SelectField, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "~/components/ui/card";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { saveClassificationOverride } from "~/lib/classification-policy-client";
import type { Inbox } from "~/lib/inbox-client";

const thresholdNames = ["probableSpam", "ambiguous", "solicitation", "lowRelevance"] as const;
const decodeOverride = Schema.decodeUnknownOption(OrganizationClassificationPolicy);
type Settings = typeof OrganizationClassificationSettings.Type;
type SaveResult = "saved" | "invalid" | "saveFailed" | null;

interface PolicyFormInput {
  thresholds?: Record<string, number>;
  offTopic?: string;
}

function PolicyForm({
  inboxId,
  settings,
}: {
  readonly inboxId: Inbox["id"];
  readonly settings: Settings;
}) {
  const { t } = useTranslation();
  const { defaults, override } = settings;
  const [thresholdMode, setThresholdMode] = useState(
    override?.thresholds === undefined ? "defaults" : "custom",
  );
  const [offTopic, setOffTopic] = useState<string>(override?.offTopic ?? "defaults");
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
    const usesDefaults = !custom && offTopic === "defaults";
    const decoded = usesDefaults ? Option.none() : decodeOverride(input);
    if (!usesDefaults && Option.isNone(decoded)) return "invalid";
    try {
      await saveClassificationOverride(inboxId, Option.getOrNull(decoded));
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
  readonly inboxId: Inbox["id"];
  readonly settings: Promise<Settings | null>;
  readonly onRetry: () => void;
}

export function ClassificationSettings({
  inboxId,
  settings,
  onRetry,
}: ClassificationSettingsProps) {
  const { t } = useTranslation();
  const initial = use(settings);
  return (
    <main className="min-w-0 lg:col-span-2 lg:overflow-y-auto">
      <header className="flex h-14 items-center gap-2 px-1">
        <SidebarTrigger />
        <h1 className="truncate text-base font-semibold">{t("inbox.sections.classification")}</h1>
      </header>
      <div className="mx-auto max-w-xl px-5 pb-8">
        <Card>
          {initial !== null && (
            <CardHeader>
              <CardDescription>
                {t("inbox.policy.description", {
                  classifier:
                    initial.classifier === "jev"
                      ? t("inbox.policy.models.jev")
                      : t("inbox.policy.models.openai"),
                })}
              </CardDescription>
            </CardHeader>
          )}
          <CardContent>
            {initial === null ? (
              <div className="grid justify-items-start gap-2">
                <FormProblem>{t("inbox.policy.loadFailed")}</FormProblem>
                <Button type="button" variant="outline" onClick={onRetry}>
                  {t("inbox.policy.retry")}
                </Button>
              </div>
            ) : (
              <PolicyForm inboxId={inboxId} settings={initial} />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
