import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Redacted, Schema } from "effect";
import { use, useActionState, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  maxActiveApiTokens,
  maxApiTokenNameLength,
  type ApiTokenList,
  type CreatedApiToken,
} from "@rondyr/organizations/api-token";

import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "~/components/ui/card";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { ApiTokenRequestFailed, createApiToken, revokeApiToken } from "~/lib/api-tokens-client";
import { useFormats } from "~/lib/i18n";
import type { Inbox } from "~/lib/inbox-client";

type ApiToken = ApiTokenList[number];
const isRequestFailure = Schema.is(ApiTokenRequestFailed);

function IssuedToken({ token, onHide }: { token: Redacted.Redacted<string>; onHide: () => void }) {
  const { t } = useTranslation();
  const [copy, setCopy] = useState<"copied" | "failed" | null>(null);

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(Redacted.value(token));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <section className="grid gap-2 rounded-md border p-3">
      <output className="text-sm">{t("inbox.apiTokens.issued")}</output>
      <code className="rounded-md bg-muted px-3 py-2 text-sm wrap-anywhere">
        {Redacted.value(token)}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void copyToken()}>
          {t("inbox.apiTokens.copy")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onHide}>
          {t("inbox.apiTokens.hide")}
        </Button>
        <output className="self-center text-sm">
          {copy === "copied" ? t("inbox.apiTokens.copied") : null}
        </output>
      </div>
      <FormProblem>{copy === "failed" ? t("inbox.apiTokens.copyFailed") : null}</FormProblem>
    </section>
  );
}

function TokenList({ inboxId, initial }: { inboxId: Inbox["id"]; initial: ApiTokenList }) {
  const { t } = useTranslation();
  const formats = useFormats();
  const [tokens, setTokens] = useState(initial);
  const [nameInput, setNameInput] = useState("");
  const [issued, setIssued] = useState<typeof CreatedApiToken.Type | null>(null);
  const [confirming, setConfirming] = useState<ApiToken | null>(null);
  const [revokeFailed, setRevokeFailed] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const revokeButton = useRef<HTMLButtonElement>(null);

  const [createFailure, create, creating] = useActionState(
    async (_: "invalidName" | "limit" | "createFailed" | null, data: FormData) => {
      const name = data.get("name")?.toString().trim() ?? "";
      if (name.length === 0) return "invalidName";
      try {
        const created = await createApiToken(inboxId, name);
        const { token, ...summary } = created;
        setTokens((current) => [summary, ...current]);
        setIssued({ ...summary, token });
        setNameInput("");
        return null;
      } catch (error) {
        if (isRequestFailure(error) && error.status === 409) return "limit";
        if (isRequestFailure(error) && error.status === 400) return "invalidName";
        return "createFailed";
      }
    },
    null,
  );

  const [, revoke, revoking] = useActionState(async () => {
    if (confirming === null) return;
    try {
      await revokeApiToken(inboxId, confirming.id);
      setTokens((current) => current.filter(({ id }) => id !== confirming.id));
      setIssued((current) => (current?.id === confirming.id ? null : current));
      setConfirming(null);
    } catch {
      setRevokeFailed(true);
    }
  }, undefined);

  const full = tokens.length >= maxActiveApiTokens;
  const createMessage = {
    invalidName: t("inbox.apiTokens.invalidName"),
    limit: t("inbox.apiTokens.limit", { limit: maxActiveApiTokens }),
    createFailed: t("inbox.apiTokens.createFailed"),
  };

  return (
    <div className="grid gap-4">
      <form action={create} className="grid gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <TextField
            ref={nameField}
            label={t("inbox.apiTokens.name")}
            name="name"
            value={nameInput}
            onChange={(event) => setNameInput(event.currentTarget.value)}
            className="min-w-0 flex-1 basis-48"
            maxLength={maxApiTokenNameLength}
            autoComplete="off"
            readOnly={creating}
            aria-invalid={createFailure === "invalidName" || undefined}
            required
          />
          <Button type="submit" disabled={creating || full}>
            {creating ? t("inbox.apiTokens.creating") : t("inbox.apiTokens.create")}
          </Button>
        </div>
        <FormProblem>
          {full
            ? createMessage.limit
            : createFailure === null
              ? null
              : createMessage[createFailure]}
        </FormProblem>
      </form>

      {issued !== null && (
        <IssuedToken
          key={issued.id}
          token={issued.token}
          onHide={() => {
            setIssued(null);
            nameField.current?.focus();
          }}
        />
      )}

      {tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("inbox.apiTokens.empty")}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {tokens.map((token) => (
            <li
              key={token.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium wrap-anywhere">{token.name}</p>
                <p className="text-xs text-muted-foreground">
                  <code>••••{token.suffix}</code>
                  {" · "}
                  <time dateTime={new Date(token.createdAt).toISOString()}>
                    {formats.longDateTime(token.createdAt)}
                  </time>
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("inbox.apiTokens.revokeLabel", { name: token.name })}
                onClick={(event) => {
                  revokeButton.current = event.currentTarget;
                  setRevokeFailed(false);
                  setConfirming(token);
                }}
              >
                {t("inbox.apiTokens.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog.Root
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !revoking) setConfirming(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
          <AlertDialog.Popup
            finalFocus={() =>
              revokeButton.current?.isConnected === true ? revokeButton.current : nameField.current
            }
            className="fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-sm -translate-1/2 gap-3 rounded-lg border bg-card p-5 text-foreground shadow-popover outline-hidden"
          >
            <AlertDialog.Title className="text-base font-semibold">
              {t("inbox.apiTokens.confirmTitle")}
            </AlertDialog.Title>
            <AlertDialog.Description className="text-sm wrap-anywhere text-muted-foreground">
              {t("inbox.apiTokens.confirmDescription", {
                name: confirming?.name ?? "",
                suffix: confirming?.suffix ?? "",
              })}
            </AlertDialog.Description>
            <form action={revoke} className="grid gap-2">
              <div className="flex flex-wrap justify-end gap-2">
                <AlertDialog.Close disabled={revoking} render={<Button variant="ghost" />}>
                  {t("common.cancel")}
                </AlertDialog.Close>
                <Button type="submit" variant="default" disabled={revoking}>
                  {revoking ? t("inbox.apiTokens.revoking") : t("inbox.apiTokens.confirm")}
                </Button>
              </div>
              <FormProblem>{revokeFailed ? t("inbox.apiTokens.revokeFailed") : null}</FormProblem>
            </form>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

interface ApiTokenSettingsProps {
  readonly inboxId: Inbox["id"];
  readonly tokens: Promise<ApiTokenList | null>;
  readonly onRetry: () => void;
}

export function ApiTokenSettings({ inboxId, tokens, onRetry }: ApiTokenSettingsProps) {
  const { t } = useTranslation();
  const initial = use(tokens);

  return (
    <main className="min-w-0 lg:col-span-2 lg:overflow-y-auto">
      <header className="flex h-14 items-center gap-2 px-1">
        <SidebarTrigger />
        <h1 className="truncate text-base font-semibold">{t("inbox.sections.apiTokens")}</h1>
      </header>
      <div className="mx-auto max-w-xl px-5 pb-8">
        <Card>
          <CardHeader>
            <CardDescription>{t("inbox.apiTokens.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            {initial === null ? (
              <div className="grid justify-items-start gap-2">
                <FormProblem>{t("inbox.apiTokens.loadFailed")}</FormProblem>
                <Button onClick={onRetry}>{t("inbox.apiTokens.retry")}</Button>
              </div>
            ) : (
              <TokenList inboxId={inboxId} initial={initial} />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
