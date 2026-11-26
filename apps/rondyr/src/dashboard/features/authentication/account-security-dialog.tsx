import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { AccountPasskeys, PasskeySummary } from "@rondyr/organizations/authentication";

import { ReadFailure } from "~/components/read-failure";
import { FormProblem, TextField } from "~/components/text-field";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import {
  addPasskeyMutation,
  deletePasskeyMutation,
  passkeyErrorOf,
  passkeysQuery,
  renamePasskeyMutation,
} from "~/lib/api/passkeys";
import { useLanguage } from "~/lib/i18n";
import { isWebAuthnClientError } from "~/lib/webauthn";

type SecurityProblem = "lastPasskey" | "exists" | "cancelled" | "unsupported" | "failed";

function securityProblemOf(cause: unknown): SecurityProblem {
  if (isWebAuthnClientError(cause)) {
    if (cause.problem === "cancelled") return "cancelled";
    if (cause.problem === "exists") return "exists";
    if (cause.problem === "unsupported") return "unsupported";
    return "failed";
  }
  const error = passkeyErrorOf(cause);
  if (error === "last-passkey") return "lastPasskey";
  if (error === "passkey-exists") return "exists";
  return "failed";
}

function formatDate(timestamp: number, language: string) {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(timestamp);
}

/**
 * Whether deleting this passkey leaves a way to sign in. Only a passkey of the current
 * domain signs in here, so the last of those stays unless email codes are enabled; the
 * Worker applies the same rule.
 */
function deletable(
  passkey: PasskeySummary,
  { passkeys, emailOtpEnabled }: AccountPasskeys,
): boolean {
  if (emailOtpEnabled || !passkey.currentDomain) return true;
  return passkeys.some((other) => other.id !== passkey.id && other.currentDomain);
}

interface PasskeyRowProps {
  readonly passkey: PasskeySummary;
  readonly canDelete: boolean;
  readonly language: string;
  readonly onProblem: (problem: SecurityProblem | null) => void;
}

function PasskeyRow({ passkey, canDelete, language, onProblem }: PasskeyRowProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(passkey.name);
  // A passkey registered without a name is stored unnamed and labelled here.
  const name = passkey.name === "" ? t("authentication.security.unnamed") : passkey.name;
  const rename = useMutation(renamePasskeyMutation());
  const remove = useMutation(deletePasskeyMutation());

  async function saveRename(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = draftName.trim();
    if (trimmed === "") return;
    onProblem(null);
    try {
      await rename.mutateAsync({ id: passkey.id, name: trimmed });
      setEditing(false);
    } catch (cause) {
      onProblem(securityProblemOf(cause));
    }
  }

  async function deleteCurrent() {
    onProblem(null);
    try {
      await remove.mutateAsync(passkey.id);
    } catch (cause) {
      onProblem(securityProblemOf(cause));
    }
  }

  return (
    <li className="grid gap-2 rounded-md border border-border p-3">
      {editing ? (
        <form onSubmit={(event) => void saveRename(event)} className="flex items-center gap-2">
          <Input
            aria-label={t("authentication.security.passkeyName")}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            maxLength={100}
            required
          />
          <Button type="submit" size="sm" disabled={rename.isPending}>
            {t("common.save")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraftName(passkey.name);
              setEditing(false);
            }}
          >
            {t("common.cancel")}
          </Button>
        </form>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 grid gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <KeyRound aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-medium wrap-anywhere">{name}</span>
              {!passkey.currentDomain && (
                <Badge variant="warning">
                  {t("authentication.security.otherDomain", { domain: passkey.rpId })}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {passkey.lastUsedAt === null
                ? t("authentication.security.addedNeverUsed", {
                    date: formatDate(passkey.createdAt, language),
                  })
                : t("authentication.security.addedLastUsed", {
                    added: formatDate(passkey.createdAt, language),
                    lastUsed: formatDate(passkey.lastUsedAt, language),
                  })}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={t("authentication.security.renameLabel", { name })}
              onClick={() => {
                setDraftName(passkey.name);
                setEditing(true);
              }}
            >
              <Pencil aria-hidden="true" className="size-4" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={t("authentication.security.deleteLabel", { name })}
              disabled={!canDelete || remove.isPending}
              onClick={() => void deleteCurrent()}
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

interface AccountSecurityDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** Account security dialog for viewing, adding, renaming, and deleting passkeys. */
export function AccountSecurityDialog({ open, onOpenChange }: AccountSecurityDialogProps) {
  const { t } = useTranslation();
  const language = useLanguage();
  const passkeys = useQuery({ ...passkeysQuery, enabled: open });
  const add = useMutation(addPasskeyMutation());
  const [newName, setNewName] = useState("");
  const [problem, setProblem] = useState<SecurityProblem | null>(null);

  const loaded = passkeys.data;

  async function addPasskey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    try {
      await add.mutateAsync(newName);
      setNewName("");
    } catch (cause) {
      setProblem(securityProblemOf(cause));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t("authentication.security.close")}>
        <DialogHeader>
          <DialogTitle>{t("authentication.security.title")}</DialogTitle>
          <DialogDescription>{t("authentication.security.description")}</DialogDescription>
        </DialogHeader>

        <section aria-label={t("authentication.security.passkeys")} className="grid gap-4">
          <h3 className="text-sm font-medium">{t("authentication.security.passkeys")}</h3>

          {passkeys.isPending && (
            <div className="grid gap-2" aria-label={t("common.loading")}>
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          )}

          {passkeys.isError && (
            <ReadFailure
              cause={passkeys.error}
              title={t("authentication.security.loadFailed")}
              retry={t("common.retry")}
              retrying={passkeys.isFetching}
              onRetry={() => void passkeys.refetch()}
            />
          )}

          {loaded !== undefined && (
            <>
              {loaded.passkeys.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("authentication.security.empty")}
                </p>
              ) : (
                <ul className="grid gap-2">
                  {loaded.passkeys.map((item) => (
                    <PasskeyRow
                      key={item.id}
                      passkey={item}
                      canDelete={deletable(item, loaded)}
                      language={language}
                      onProblem={setProblem}
                    />
                  ))}
                </ul>
              )}

              {loaded.passkeys.some((item) => !deletable(item, loaded)) && (
                <p className="text-xs text-pretty text-muted-foreground">
                  {t("authentication.security.lastPasskeyHint")}
                </p>
              )}

              {loaded.passkeys.length > 0 && (
                <p className="text-xs text-pretty text-muted-foreground">
                  {t("authentication.security.deleteSignsOut")}
                </p>
              )}

              <FormProblem>
                {problem === null ? null : t(`authentication.security.problems.${problem}`)}
              </FormProblem>

              <form
                onSubmit={(event) => void addPasskey(event)}
                className="grid gap-3 border-t border-border pt-3"
              >
                <TextField
                  label={t("authentication.security.newPasskeyName")}
                  name="passkeyName"
                  placeholder={t("authentication.security.newPasskeyPlaceholder")}
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  maxLength={100}
                />
                <Button type="submit" variant="default" disabled={add.isPending}>
                  <Plus aria-hidden="true" className="size-4" />
                  {add.isPending
                    ? t("authentication.security.adding")
                    : t("authentication.security.add")}
                </Button>
              </form>
            </>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
