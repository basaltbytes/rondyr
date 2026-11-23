import { Option, Schema } from "effect";
import { use, useActionState, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  maxOrganizationDomains,
  type OrganizationDomainList,
} from "@rondyr/organizations/organization-domain";

import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "~/components/ui/card";
import { SidebarTrigger } from "~/components/ui/sidebar";
import type { Inbox } from "~/lib/inbox-client";
import { addDomain, DomainRequestFailed, removeDomain } from "~/lib/organization-domains-client";

const isRequestFailure = Schema.is(DomainRequestFailed);

type AddFailure = "invalid-domain" | "domain-limit" | "not-added";

interface DomainListProps {
  readonly inboxId: Inbox["id"];
  readonly initialDomains: OrganizationDomainList;
}

function DomainList({ inboxId, initialDomains }: DomainListProps) {
  const { t } = useTranslation();
  const [domains, setDomains] = useState(initialDomains);
  const [input, setInput] = useState("");

  const [addFailure, add, adding] = useActionState(async (_: AddFailure | null, data: FormData) => {
    const hostname = data.get("domain")?.toString() ?? "";
    try {
      const { domain } = await addDomain(inboxId, hostname);
      setDomains((current) =>
        current.includes(domain) ? current : [...current, domain].toSorted(),
      );
      setInput("");
      return null;
    } catch (error) {
      if (isRequestFailure(error)) {
        if (Option.isSome(error.problem)) return error.problem.value.error;
      }
      return "not-added";
    }
  }, null);

  const [removeFailed, remove, removing] = useActionState(async (_: boolean, data: FormData) => {
    const domain = data.get("domain")?.toString() ?? "";
    try {
      await removeDomain(inboxId, domain);
      setDomains((current) => current.filter((item) => item !== domain));
      return false;
    } catch {
      return true;
    }
  }, false);

  const busy = adding || removing;
  const addMessage = {
    "invalid-domain": t("inbox.domains.invalid"),
    "domain-limit": t("inbox.domains.limit", { limit: maxOrganizationDomains }),
    "not-added": t("inbox.domains.addFailed"),
  };

  return (
    <div className="grid gap-4">
      {domains.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("inbox.domains.empty")}</p>
      ) : (
        <ul className="grid gap-px overflow-hidden rounded-md bg-border shadow-raised">
          {domains.map((domain) => (
            <li key={domain} className="bg-card py-1 pr-1 pl-3">
              <form action={remove} className="flex items-center gap-3">
                <code className="min-w-0 flex-1 font-mono text-sm wrap-anywhere">{domain}</code>
                <input type="hidden" name="domain" value={domain} />
                <Button
                  type="submit"
                  variant="ghost"
                  className="pointer-coarse:min-h-11"
                  aria-label={t("inbox.domains.removeLabel", { domain })}
                  disabled={busy}
                >
                  {t("inbox.domains.remove")}
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <FormProblem>{removeFailed ? t("inbox.domains.removeFailed") : null}</FormProblem>
      <form action={add} className="grid gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <TextField
            label={t("inbox.domains.hostname")}
            className="min-w-0 flex-1 basis-56"
            name="domain"
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            readOnly={adding}
            required
            maxLength={253}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("inbox.domains.placeholder")}
            aria-invalid={addFailure === "invalid-domain" || undefined}
          />
          <Button type="submit" className="pointer-coarse:min-h-11" disabled={busy}>
            {t("inbox.domains.add")}
          </Button>
        </div>
        <FormProblem>{addFailure === null ? null : addMessage[addFailure]}</FormProblem>
      </form>
    </div>
  );
}

interface OrganizationDomainsProps {
  readonly inboxId: Inbox["id"];
  readonly domains: Promise<OrganizationDomainList | null>;
  readonly onRetry: () => void;
}

export function OrganizationDomains({ inboxId, domains, onRetry }: OrganizationDomainsProps) {
  const { t } = useTranslation();
  const initialDomains = use(domains);

  return (
    <main className="min-w-0 lg:col-span-2 lg:overflow-y-auto">
      <header className="flex h-14 items-center gap-2 px-1">
        <SidebarTrigger />
        <h1 className="truncate text-base font-semibold">{t("inbox.sections.domains")}</h1>
      </header>
      <div className="mx-auto max-w-xl px-5 pb-8">
        <Card>
          <CardHeader>
            <CardDescription>
              {t("inbox.domains.description", { limit: maxOrganizationDomains })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {initialDomains === null ? (
              <div className="grid justify-items-start gap-2">
                <FormProblem>{t("inbox.domains.loadFailed")}</FormProblem>
                <Button type="button" variant="outline" onClick={onRetry}>
                  {t("inbox.domains.retry")}
                </Button>
              </div>
            ) : (
              <DomainList inboxId={inboxId} initialDomains={initialDomains} />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
