import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Redacted } from "effect";
import { useActionState, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MemberRole } from "@rondyr/organizations/member-role";

import { ReadFailure } from "~/components/read-failure";
import { FormProblem, SelectField, TextField } from "~/components/text-field";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { NativeSelect } from "~/components/ui/native-select";
import { SidebarTrigger } from "~/components/ui/sidebar";
import {
  changeMembersMutation,
  memberErrorOf,
  membersQuery,
  type IssuedInvitation,
  type Member,
  type OrganizationMembers,
} from "~/lib/api/members";
import { useFormats, useLanguage } from "~/lib/i18n";

const roles = ["reviewer", "admin"] as const satisfies ReadonlyArray<MemberRole>;

type Issued = IssuedInvitation;
type InviteProblem = "alreadyMember" | "limit" | "inviteFailed";
type MemberProblem = "lastAdmin" | "changeFailed" | "removeFailed" | "cancelFailed";

function IssuedLink({ issued, onHide }: { issued: Issued; onHide: () => void }) {
  const { t } = useTranslation();
  const [copy, setCopy] = useState<"copied" | "failed" | null>(null);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(Redacted.value(issued.link));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <section className="grid gap-2 rounded-md border p-4">
      <output className="text-sm text-pretty">
        {t(`inbox.members.emails.${issued.email}`, { email: issued.invitation.email })}
      </output>
      <code className="rounded-md bg-muted px-4 py-2.5 text-sm wrap-anywhere">
        {Redacted.value(issued.link)}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void copyLink()}>
          {t("inbox.members.copyLink")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onHide}>
          {t("inbox.members.hideLink")}
        </Button>
        <output className="self-center text-sm">
          {copy === "copied" ? t("inbox.members.copied") : null}
        </output>
      </div>
      <FormProblem>{copy === "failed" ? t("inbox.members.copyFailed") : null}</FormProblem>
    </section>
  );
}

interface MemberManagerProps {
  readonly organizationId: string;
  readonly list: OrganizationMembers;
  /** When the list was read: an invitation that expired before it shows as expired. */
  readonly readAt: number;
  /** The user ID of the signed-in account. */
  readonly self: string;
}

function MemberManager({ organizationId, list, readAt, self }: MemberManagerProps) {
  const { t } = useTranslation();
  const formats = useFormats();
  const language = useLanguage();
  const { members, invitations } = list;
  const { mutateAsync: change } = useMutation(changeMembersMutation(organizationId, self));
  const [issued, setIssued] = useState<Issued | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [problem, setProblem] = useState<MemberProblem | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  // The account's own change from admin to reviewer, which only another admin can undo.
  const [steppingDown, setSteppingDown] = useState<Member | null>(null);
  const emailField = useRef<HTMLInputElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);

  const [inviteProblem, invite, inviting] = useActionState(
    async (_: InviteProblem | null, data: FormData): Promise<InviteProblem | null> => {
      const email = data.get("email")?.toString().trim() ?? "";
      const role = data.get("role") === "admin" ? "admin" : "reviewer";
      try {
        const invited = await change({ change: "invite", email, role, language });
        if (invited.change === "invite") setIssued(invited.issued);
        setEmailInput("");
        return null;
      } catch (cause) {
        if (memberErrorOf(cause) === "already-member") return "alreadyMember";
        if (memberErrorOf(cause) === "invitation-limit") return "limit";
        return "inviteFailed";
      }
    },
    null,
  );

  async function changeRole(member: Member, role: MemberRole) {
    setProblem(null);
    try {
      await change({ change: "role", member: member.userId, role });
    } catch (cause) {
      setProblem(memberErrorOf(cause) === "last-admin" ? "lastAdmin" : "changeFailed");
    }
  }

  async function cancel(id: OrganizationMembers["invitations"][number]["id"]) {
    setProblem(null);
    try {
      await change({ change: "cancel", invitation: id });
      setIssued((current) => (current?.invitation.id === id ? null : current));
    } catch {
      setProblem("cancelFailed");
    }
  }

  const [, stepDown, steppingDownPending] = useActionState(async () => {
    if (steppingDown === null) return;
    await changeRole(steppingDown, "reviewer");
    setSteppingDown(null);
  }, undefined);

  const [, remove, removingPending] = useActionState(async () => {
    if (removing === null) return;
    setProblem(null);
    try {
      await change({ change: "remove", member: removing.userId });
    } catch (cause) {
      setProblem(memberErrorOf(cause) === "last-admin" ? "lastAdmin" : "removeFailed");
    }
    setRemoving(null);
  }, undefined);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("inbox.members.title")}</CardTitle>
          <CardDescription>{t("inbox.members.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3">
            <ul className="divide-y rounded-md border">
              {members.map((member) => (
                <li
                  key={member.userId}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="text-sm font-medium wrap-anywhere">
                      {member.name}
                      {member.userId === self && (
                        <span className="ml-2 font-normal text-muted-foreground">
                          {t("inbox.members.you")}
                        </span>
                      )}
                    </p>
                    <p className="text-xs wrap-anywhere text-muted-foreground">{member.email}</p>
                  </div>
                  <NativeSelect
                    aria-label={t("inbox.members.roleOf", { name: member.name })}
                    className="w-auto"
                    value={member.role}
                    onChange={(event) => {
                      const role = event.currentTarget.value === "admin" ? "admin" : "reviewer";
                      if (
                        member.userId === self &&
                        member.role === "admin" &&
                        role === "reviewer"
                      ) {
                        setProblem(null);
                        setSteppingDown(member);
                        return;
                      }
                      void changeRole(member, role);
                    }}
                  >
                    {roles.map((role) => (
                      <option key={role} value={role}>
                        {t(`inbox.members.roles.${role}`)}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("inbox.members.removeLabel", { name: member.name })}
                    onClick={(event) => {
                      removeButton.current = event.currentTarget;
                      setProblem(null);
                      setRemoving(member);
                    }}
                  >
                    {t("inbox.members.remove")}
                  </Button>
                </li>
              ))}
            </ul>
            <FormProblem>
              {problem === null ? null : t(`inbox.members.problems.${problem}`)}
            </FormProblem>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("inbox.members.inviteTitle")}</CardTitle>
          <CardDescription>{t("inbox.members.inviteDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4">
            <form action={invite} className="grid gap-3">
              <div className="flex flex-wrap items-end gap-2">
                <TextField
                  ref={emailField}
                  label={t("inbox.members.email")}
                  type="email"
                  name="email"
                  value={emailInput}
                  onChange={(event) => setEmailInput(event.currentTarget.value)}
                  className="min-w-0 flex-1 basis-56"
                  autoComplete="off"
                  readOnly={inviting}
                  required
                />
                <SelectField
                  label={t("inbox.members.role")}
                  name="role"
                  defaultValue="reviewer"
                  className="w-40"
                >
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {t(`inbox.members.roles.${role}`)}
                    </option>
                  ))}
                </SelectField>
                <Button type="submit" disabled={inviting}>
                  {inviting ? t("inbox.members.inviting") : t("inbox.members.invite")}
                </Button>
              </div>
              <p className="text-xs text-pretty text-muted-foreground">
                {t("inbox.members.rolesHint")}
              </p>
              <FormProblem>
                {inviteProblem === null ? null : t(`inbox.members.problems.${inviteProblem}`)}
              </FormProblem>
            </form>
            {issued !== null && (
              <IssuedLink
                key={issued.invitation.id}
                issued={issued}
                onHide={() => {
                  setIssued(null);
                  emailField.current?.focus();
                }}
              />
            )}
            {invitations.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("inbox.members.noInvitations")}</p>
            ) : (
              <ul aria-label={t("inbox.members.pending")} className="divide-y rounded-md border">
                {invitations.map((invitation) => (
                  <li
                    key={invitation.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="text-sm font-medium wrap-anywhere">{invitation.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {t(`inbox.members.roles.${invitation.role}`)}
                        {" · "}
                        {invitation.expiresAt <= readAt ? (
                          <Badge variant="neutral">{t("inbox.members.expired")}</Badge>
                        ) : (
                          t("inbox.members.expires", {
                            date: formats.longDateTime(invitation.expiresAt),
                          })
                        )}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("inbox.members.cancelLabel", { email: invitation.email })}
                      onClick={() => void cancel(invitation.id)}
                    >
                      {t("inbox.members.cancelInvitation")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <AlertDialog.Root
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !removingPending) setRemoving(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
          <AlertDialog.Popup
            finalFocus={() =>
              removeButton.current?.isConnected === true ? removeButton.current : emailField.current
            }
            className="fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-sm -translate-1/2 gap-3 rounded-lg border bg-card p-5 text-foreground shadow-popover outline-hidden"
          >
            <AlertDialog.Title className="text-base font-semibold">
              {t("inbox.members.confirmTitle")}
            </AlertDialog.Title>
            <AlertDialog.Description className="grid gap-2 text-sm wrap-anywhere text-muted-foreground">
              <span>
                {t("inbox.members.confirmDescription", {
                  name: removing?.name ?? "",
                  email: removing?.email ?? "",
                })}
              </span>
              {(removing?.activeApiTokens ?? 0) > 0 && (
                <span className="font-medium text-foreground">
                  {t("inbox.members.confirmTokens", { count: removing?.activeApiTokens ?? 0 })}
                </span>
              )}
            </AlertDialog.Description>
            <form action={remove} className="flex flex-wrap justify-end gap-2">
              <AlertDialog.Close disabled={removingPending} render={<Button variant="ghost" />}>
                {t("common.cancel")}
              </AlertDialog.Close>
              <Button type="submit" variant="default" disabled={removingPending}>
                {removingPending ? t("inbox.members.removing") : t("inbox.members.confirm")}
              </Button>
            </form>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root
        open={steppingDown !== null}
        onOpenChange={(open) => {
          if (!open && !steppingDownPending) setSteppingDown(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
          {/* Focus goes back to the role of the account, which had it before. */}
          <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-sm -translate-1/2 gap-3 rounded-lg border bg-card p-5 text-foreground shadow-popover outline-hidden">
            <AlertDialog.Title className="text-base font-semibold">
              {t("inbox.members.stepDownTitle")}
            </AlertDialog.Title>
            <AlertDialog.Description className="text-sm text-pretty text-muted-foreground">
              {t("inbox.members.stepDownDescription")}
            </AlertDialog.Description>
            <form action={stepDown} className="flex flex-wrap justify-end gap-2">
              <AlertDialog.Close disabled={steppingDownPending} render={<Button variant="ghost" />}>
                {t("common.cancel")}
              </AlertDialog.Close>
              <Button type="submit" variant="default" disabled={steppingDownPending}>
                {steppingDownPending
                  ? t("inbox.members.steppingDown")
                  : t("inbox.members.stepDown")}
              </Button>
            </form>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

interface MemberSettingsProps {
  readonly organizationId: string;
  /** The user ID of the signed-in account. */
  readonly self: string;
}

export function MemberSettings({ organizationId, self }: MemberSettingsProps) {
  const { t } = useTranslation();
  const members = useQuery(membersQuery(organizationId));

  return (
    <main className="min-w-0 lg:col-span-2 lg:overflow-y-auto">
      <header className="flex h-14 items-center gap-2 px-1">
        <SidebarTrigger />
        <h1 className="truncate text-base font-semibold">{t("inbox.sections.members")}</h1>
      </header>
      <div className="mx-auto max-w-xl px-5 pb-8">
        {members.isError && (
          <ReadFailure
            cause={members.error}
            title={t("inbox.members.loadFailed")}
            retry={t("inbox.members.retry")}
            retrying={members.isFetching}
            onRetry={() => void members.refetch()}
          />
        )}
        {members.isPending && (
          <output className="text-sm text-muted-foreground">{t("common.loading")}</output>
        )}
        {members.isSuccess && (
          <MemberManager
            organizationId={organizationId}
            list={members.data}
            readAt={members.dataUpdatedAt}
            self={self}
          />
        )}
      </div>
    </main>
  );
}
