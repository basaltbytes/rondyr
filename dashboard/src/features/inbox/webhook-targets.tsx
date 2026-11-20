import { useActionState, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { FormProblem, TextField } from "~/components/text-field";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useFormats } from "~/lib/i18n";
import type { Inbox } from "~/lib/inbox-client";
import {
  createWebhook,
  isWebhook,
  listTargets,
  rotateSecret,
  setTargetActive,
} from "~/lib/targets-client";
import type { IssuedSecret, Webhook } from "~/lib/targets-client";

import { attempt, TargetFailureNote } from "./target-problems.tsx";
import type { TargetFailure } from "./target-problems.tsx";
import { TargetTest } from "./target-test.tsx";

interface WebhookTargetsProps {
  readonly inboxId: Inbox["id"];
  readonly form: Inbox["forms"][number];
}

export function WebhookTargets({ inboxId, form }: WebhookTargetsProps) {
  const { t } = useTranslation();
  const format = useFormats();
  const [targets, setTargets] = useState<readonly Webhook[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [issued, setIssued] = useState<IssuedSecret | null>(null);
  const [copied, setCopied] = useState(false);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the form's webhook targets from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listTargets(inboxId, form.publicId, request.signal).then(
      (all) => setTargets(all.filter(isWebhook)),
      () => {
        if (!request.signal.aborted) setFailed(true);
      },
    );
    return () => request.abort();
  }, [inboxId, form.publicId]);

  function replace(target: Webhook) {
    setTargets(
      (current) => current?.map((item) => (item.id === target.id ? target : item)) ?? null,
    );
  }

  function show(next: IssuedSecret) {
    setIssued(next);
    setCopied(false);
  }

  const [addFailure, add, adding] = useActionState((_: TargetFailure | null, data: FormData) => {
    const url = data.get("url")?.toString() ?? "";
    return attempt(async () => {
      const next = await createWebhook(inboxId, form.publicId, url);
      setTargets((current) => [...(current ?? []), next.target]);
      show(next);
    });
  }, null);

  const [actionFailure, act, acting] = useActionState((_: TargetFailure | null, data: FormData) => {
    const target = targets?.find(({ id }) => id === data.get("target"));
    const action = data.get("action");
    if (target === undefined) return null;
    return attempt(async () => {
      if (action === "rotate") {
        const next = await rotateSecret(inboxId, target.id);
        replace(next.target);
        show(next);
      } else if (action === "activate" || action === "deactivate") {
        const next = await setTargetActive(inboxId, target.id, action);
        if (isWebhook(next)) replace(next);
      }
    });
  }, null);

  return (
    <Card aria-label={t("inbox.webhooks.label", { name: form.name })}>
      <CardHeader>
        <CardTitle>{t("inbox.webhooks.title")}</CardTitle>
        <CardDescription>{t("inbox.webhooks.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {failed && <FormProblem>{t("inbox.webhooks.loadFailed")}</FormProblem>}
        {targets === null && !failed && (
          <output className="text-sm text-muted-foreground">{t("inbox.webhooks.loading")}</output>
        )}
        {targets?.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("inbox.webhooks.empty")}</p>
        )}
        {targets !== null && targets.length > 0 && (
          <ul className="grid gap-px overflow-hidden rounded-md bg-border shadow-raised">
            {targets.map((target) => (
              <li key={target.id} className="grid gap-2 bg-card px-3 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <code className="min-w-0 flex-1 basis-56 font-mono text-sm wrap-anywhere">
                    {target.url}
                  </code>
                  <Badge variant={target.active ? "success" : "neutral"}>
                    {target.active ? t("inbox.webhooks.active") : t("inbox.webhooks.inactive")}
                  </Badge>
                </div>
                {target.previousSecretExpiresAt !== null && (
                  <p className="text-xs text-pretty text-muted-foreground tabular-nums">
                    {t("inbox.webhooks.previousSecret", {
                      date: format.shortDateTime(target.previousSecretExpiresAt),
                    })}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <TargetTest inboxId={inboxId} targetId={target.id} />
                  <form action={act} className="contents">
                    <input type="hidden" name="target" value={target.id} />
                    <Button type="submit" size="sm" name="action" value="rotate" disabled={acting}>
                      {t("inbox.webhooks.rotate")}
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      variant="ghost"
                      name="action"
                      value={target.active ? "deactivate" : "activate"}
                      disabled={acting}
                    >
                      {target.active
                        ? t("inbox.destinations.deactivate")
                        : t("inbox.destinations.reactivate")}
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
        <TargetFailureNote failure={actionFailure} fallback={t("inbox.destinations.notSaved")} />
        {issued !== null && (
          <Alert>
            <AlertTitle>{t("inbox.webhooks.secret.title")}</AlertTitle>
            <AlertDescription>
              <p>
                <Trans
                  i18nKey="inbox.webhooks.secret.description"
                  values={{ url: issued.target.url }}
                  components={{ code: <code className="font-mono wrap-anywhere" /> }}
                />
              </p>
              <code className="rounded-md bg-card px-3 py-2 font-mono text-sm wrap-anywhere">
                {issued.secret}
              </code>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(issued.secret).then(() => setCopied(true));
                  }}
                >
                  {copied ? t("inbox.webhooks.secret.copied") : t("inbox.webhooks.secret.copy")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
                  {t("inbox.webhooks.secret.hide")}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        <form action={add} className="grid gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <TextField
              label={t("inbox.webhooks.url")}
              className="min-w-0 flex-1 basis-64"
              type="url"
              name="url"
              required
              maxLength={2048}
              placeholder={t("inbox.webhooks.placeholder")}
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={adding}>
              {t("inbox.webhooks.add")}
            </Button>
          </div>
          <TargetFailureNote failure={addFailure} fallback={t("inbox.webhooks.notAdded")} />
        </form>
      </CardContent>
    </Card>
  );
}
