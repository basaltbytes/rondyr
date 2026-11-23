import { useActionState, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useFormats } from "~/lib/i18n";
import type { Inbox } from "~/lib/inbox-client";
import { rotateSecret } from "~/lib/targets-client";
import type { IssuedSecret, Webhook } from "~/lib/targets-client";

import { attempt, TargetFailureNote } from "./target-problems.tsx";
import { TargetTest } from "./target-test.tsx";

interface IssuedSecretNoteProps {
  readonly issued: IssuedSecret;
  readonly onHide: () => void;
}

/** The signing secret of a webhook, shown once: when it is created and when it is rotated. */
function IssuedSecretNote({ issued, onHide }: IssuedSecretNoteProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
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
        <code className="rounded-md bg-card px-4 py-2.5 font-mono text-sm wrap-anywhere">
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
          <Button size="sm" variant="ghost" onClick={onHide}>
            {t("inbox.webhooks.secret.hide")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

interface WebhookPanelProps {
  readonly inboxId: Inbox["id"];
  readonly target: Webhook;
  /** The secret that the API just issued for this webhook, if any. */
  readonly issued: IssuedSecret | null;
  readonly onReplaced: (target: Webhook) => void;
  /** Show a new secret, or hide the one shown with null. */
  readonly onIssued: (issued: IssuedSecret | null) => void;
}

/** What an open webhook shows: its secret when one was just issued, its test and its rotation. */
export function WebhookPanel({ inboxId, target, issued, onReplaced, onIssued }: WebhookPanelProps) {
  const { t } = useTranslation();
  const format = useFormats();
  const [failure, rotate, rotating] = useActionState(
    () =>
      attempt(async () => {
        const next = await rotateSecret(inboxId, target.id);
        onReplaced(next.target);
        onIssued(next);
      }),
    null,
  );

  return (
    <>
      <p className="text-xs text-pretty text-muted-foreground">{t("inbox.webhooks.description")}</p>
      {target.previousSecretExpiresAt !== null && (
        <p className="text-xs text-pretty text-muted-foreground tabular-nums">
          {t("inbox.webhooks.previousSecret", {
            date: format.shortDateTime(target.previousSecretExpiresAt),
          })}
        </p>
      )}
      {issued !== null && <IssuedSecretNote issued={issued} onHide={() => onIssued(null)} />}
      <div className="flex flex-wrap items-center gap-2">
        <TargetTest inboxId={inboxId} targetId={target.id} />
        <form action={rotate} className="contents">
          <Button type="submit" size="sm" disabled={rotating}>
            {t("inbox.webhooks.rotate")}
          </Button>
        </form>
      </div>
      <TargetFailureNote failure={failure} fallback={t("inbox.destinations.notSaved")} />
    </>
  );
}
