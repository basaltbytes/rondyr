import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Redacted, Schema } from "effect";
import { use, useActionState, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MemberRole } from "@rondyr/organizations/member-role";
import type { IssuedInvitation } from "@rondyr/organizations/members";

import { FormProblem, SelectField, TextField } from "~/components/text-field";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { NativeSelect } from "~/components/ui/native-select";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { authClient } from "~/lib/auth-client";
import { useFormats, useLanguage } from "~/lib/i18n";
import type { Inbox } from "~/lib/inbox-client";
import {
  cancelInvitation,
  changeMemberRole,
  inviteMember,
  MemberRequestFailed,
  removeMember,
} from "~/lib/members-client";
import type { MemberList, OrganizationMember } from "~/lib/members-client";

const isRequestFailure = Schema.is(MemberRequestFailed);
const roles = ["reviewer", "admin"] as const satisfies ReadonlyArray<MemberRole>;

type Issued = typeof IssuedInvitation.Type;
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
    <section className="grid gap-2 rounded-md border p-3">
      <output className="text-sm text-pretty">
        {t(`inbox.members.emails.${issued.email}`, { email: issued.invitation.email })}
      </output>
      <code className="rounded-md bg-muted px-3 py-2 text-sm wrap-anywhere">
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
  readonly inboxId: Inbox["id"];
  readonly initial: MemberList;
  /** When the list was read: an invitation that expired before it shows as expired. */
  readonly readAt: number;
  /** Reload the organizations after a change to the account's own membership. */
  readonly onOwnMembershipChanged: () => void;
}

function MemberManager({ inboxId, initial, readAt, onOwnMembershipChanged }: MemberManagerProps) {
  const { t } = useTranslation();
  const formats = useFormats();
  const language = useLanguage();
  const session = authClient.useSession();
  const self = session.data?.user.id ?? null;
  const [members, setMembers] = useState(initial.members);
  const [invitations, setInvitations] = useState(initial.invitations);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [problem, setProblem] = useState<MemberProblem | null>(null);
  const [removing, setRemoving] = useState<OrganizationMember | null>(null);
  // The account's own change from admin to reviewer, which only another admin can undo.
  const [steppingDown, setSteppingDown] = useState<OrganizationMember | null>(null);
  const emailField = useRef<HTMLInputElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);

  const [inviteProblem, invite, inviting] = useActionState(
    async (_: InviteProblem | null, data: FormData): Promise<InviteProblem | null> => {
      const email = data.get("email")?.toString().trim() ?? "";
      const role = data.get("role") === "admin" ? "admin" : "reviewer";
      try {
        const created = await inviteMember(inboxId, email, role, language);
        setInvitations((current) => [
          created.invitation,
          ...current.filter(({ email: other }) => other !== created.invitation.email),
        ]);
        setIssued(created);
        setEmailInput("");
        return null;
      } catch (error) {
        if (isRequestFailure(error) && error.error === "already-member") return "alreadyMember";
        if (isRequestFailure(error) && error.error === "invitation-limit") return "limit";
        return "inviteFailed";
      }
    },
    null,
  );

  async function changeRole(member: OrganizationMember, role: MemberRole) {
    setProblem(null);
    try {
      const changed = await changeMemberRole(inboxId, member.userId, role);
      setMembers((current) =>
        current.map((other) => (other.userId === changed.userId ? changed : other)),
      );
      if (changed.userId === self) onOwnMembershipChanged();
    } catch (error) {
      setProblem(
        isRequestFailure(error) && error.error === "last-admin" ? "lastAdmin" : "changeFailed",
      );
    }
  }

  async function cancel(id: MemberList["invitations"][number]["id"]) {
    setProblem(null);
    try {
      await cancelInvitation(inboxId, id);
      setInvitations((current) => current.filter((invitation) => invitation.id !== id));
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
      await removeMember(inboxId, removing.userId);
      setMembers((current) => current.filter(({ userId }) => userId !== removing.userId));
      if (removing.userId === self) onOwnMembershipChanged();
    } catch (error) {
      setProblem(
        isRequestFailure(error) && error.error === "last-admin" ? "lastAdmin" : "removeFailed",
      );
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
  readonly inboxId: Inbox["id"];
  readonly members: Promise<MemberList | null>;
  readonly readAt: number;
  readonly onRetry: () => void;
  readonly onOwnMembershipChanged: () => void;
}

export function MemberSettings({
  inboxId,
  members,
  readAt,
  onRetry,
  onOwnMembershipChanged,
}: MemberSettingsProps) {
  const { t } = useTranslation();
  const initial = use(members);

  return (
    <main className="min-w-0 lg:col-span-2 lg:overflow-y-auto">
      <header className="flex h-14 items-center gap-2 px-1">
        <SidebarTrigger />
        <h1 className="truncate text-base font-semibold">{t("inbox.sections.members")}</h1>
      </header>
      <div className="mx-auto max-w-xl px-5 pb-8">
        {initial === null ? (
          <div className="grid justify-items-start gap-2">
            <FormProblem>{t("inbox.members.loadFailed")}</FormProblem>
            <Button onClick={onRetry}>{t("inbox.members.retry")}</Button>
          </div>
        ) : (
          <MemberManager
            inboxId={inboxId}
            initial={initial}
            readAt={readAt}
            onOwnMembershipChanged={onOwnMembershipChanged}
          />
        )}
      </div>
    </main>
  );
}
