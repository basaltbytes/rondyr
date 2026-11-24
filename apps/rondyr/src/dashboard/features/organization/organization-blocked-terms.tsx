import { useMutation, useQuery } from "@tanstack/react-query";
import { Option } from "effect";
import { X } from "lucide-react";
import { useActionState, useState } from "react";
import { useTranslation } from "react-i18next";

import { maxBlockedTermLength, maxOrganizationBlockedTerms } from "@rondyr/forms/blocked-term";

import { CardListSkeleton } from "~/components/page-pending";
import { ReadFailure } from "~/components/read-failure";
import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "~/components/ui/card";
import { SidebarTrigger } from "~/components/ui/sidebar";
import {
  addOrganizationBlockedTermMutation,
  blockedTermRefusalOf,
  organizationBlockedTermsQuery,
  removeOrganizationBlockedTermMutation,
  type BlockedTermRequestError,
  type FormBlockedTerm,
} from "~/lib/api/blocked-terms";

type BlockedTermFailure = BlockedTermRequestError | "unexplained";

async function attempt(request: () => Promise<void>): Promise<BlockedTermFailure | null> {
  try {
    await request();
    return null;
  } catch (cause) {
    return Option.getOrElse(blockedTermRefusalOf(cause), (): BlockedTermFailure => "unexplained");
  }
}

interface OrganizationBlockedTermListProps {
  readonly organizationId: string;
  readonly terms: ReadonlyArray<FormBlockedTerm>;
}

function OrganizationBlockedTermList({ organizationId, terms }: OrganizationBlockedTermListProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const { mutateAsync: addTerm } = useMutation(addOrganizationBlockedTermMutation(organizationId));
  const { mutateAsync: removeTerm } = useMutation(
    removeOrganizationBlockedTermMutation(organizationId),
  );

  const [addFailure, add, adding] = useActionState(
    (_: BlockedTermFailure | null, data: FormData) => {
      const term = data.get("term")?.toString() ?? "";
      return attempt(async () => {
        await addTerm(term);
        setInput("");
      });
    },
    null,
  );

  const [removeFailure, remove, removing] = useActionState(
    (_: BlockedTermFailure | null, data: FormData) => {
      const term = data.get("term")?.toString() ?? "";
      return attempt(async () => {
        await removeTerm(term);
      });
    },
    null,
  );

  function explain(failure: BlockedTermFailure, fallback: string) {
    if (failure === "unexplained") return fallback;
    if (failure.error === "term-limit") {
      return t("inbox.blockedTerms.organizationLimit", { limit: maxOrganizationBlockedTerms });
    }
    return failure.reason === "empty"
      ? t("inbox.blockedTerms.refusals.empty")
      : t("inbox.blockedTerms.refusals.tooLong", { max: maxBlockedTermLength });
  }

  const busy = adding || removing;

  return (
    <div className="grid gap-4">
      {terms.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("inbox.blockedTerms.organizationEmpty")}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {terms.map((item) => (
            <li key={item.term} className="max-w-full rounded-md bg-muted">
              <form action={remove} className="flex min-h-9 items-center gap-1 pr-1 pl-3">
                <code className="min-w-0 font-mono text-sm wrap-anywhere">{item.term}</code>
                <input type="hidden" name="term" value={item.term} />
                <Button
                  type="submit"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("inbox.blockedTerms.removeLabel", { term: item.term })}
                  disabled={busy}
                >
                  <X aria-hidden="true" className="size-4" />
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <FormProblem>
        {removeFailure === null
          ? null
          : explain(removeFailure, t("inbox.blockedTerms.problems.notRemoved"))}
      </FormProblem>
      <form action={add} className="grid gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <TextField
            label={t("inbox.blockedTerms.term")}
            className="min-w-0 flex-1 basis-56"
            name="term"
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            readOnly={adding}
            required
            maxLength={maxBlockedTermLength}
            autoComplete="off"
            placeholder={t("inbox.blockedTerms.placeholder")}
            aria-invalid={
              (addFailure !== null &&
                addFailure !== "unexplained" &&
                addFailure.error === "term-refused") ||
              undefined
            }
          />
          <Button type="submit" className="pointer-coarse:min-h-11" disabled={busy}>
            {t("inbox.blockedTerms.add")}
          </Button>
        </div>
        <FormProblem>
          {addFailure === null
            ? null
            : explain(addFailure, t("inbox.blockedTerms.problems.notAdded"))}
        </FormProblem>
      </form>
    </div>
  );
}

interface OrganizationBlockedTermsProps {
  readonly organizationId: string;
}

export function OrganizationBlockedTerms({ organizationId }: OrganizationBlockedTermsProps) {
  const { t } = useTranslation();
  const terms = useQuery(organizationBlockedTermsQuery(organizationId));

  return (
    <main className="min-w-0 lg:col-span-2 lg:overflow-y-auto">
      <header className="flex h-14 items-center gap-2 px-1">
        <SidebarTrigger />
        <h1 className="truncate text-base font-semibold">{t("inbox.sections.blockedTerms")}</h1>
      </header>
      <div className="mx-auto max-w-xl px-5 pb-8">
        <Card>
          <CardHeader>
            <CardDescription>
              {t("inbox.blockedTerms.organizationDescription", {
                limit: maxOrganizationBlockedTerms,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {terms.isError && (
              <ReadFailure
                cause={terms.error}
                title={t("inbox.blockedTerms.loadFailed")}
                retry={t("common.retry")}
                retrying={terms.isFetching}
                onRetry={() => void terms.refetch()}
              />
            )}
            {terms.isPending && <CardListSkeleton label={t("inbox.blockedTerms.loading")} />}
            {terms.isSuccess && (
              <OrganizationBlockedTermList organizationId={organizationId} terms={terms.data} />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
