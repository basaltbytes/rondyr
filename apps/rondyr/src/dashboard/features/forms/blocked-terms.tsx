import { useMutation, useQuery } from "@tanstack/react-query";
import { Option } from "effect";
import { X } from "lucide-react";
import { useActionState, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { maxBlockedTermLength, maxFormBlockedTerms } from "@rondyr/forms/blocked-term";

import { ChipListSkeleton } from "~/components/page-pending";
import { ReadFailure } from "~/components/read-failure";
import { FormProblem } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  addBlockedTermMutation,
  blockedTermRefusalOf,
  blockedTermsQuery,
  removeBlockedTermMutation,
  type BlockedTermRequestError,
} from "~/lib/api/blocked-terms";
import type { ManagedForm } from "~/lib/api/forms";

type BlockedTermFailure = BlockedTermRequestError | "unexplained";

async function attempt(request: () => Promise<void>): Promise<BlockedTermFailure | null> {
  try {
    await request();
    return null;
  } catch (cause) {
    return Option.getOrElse(blockedTermRefusalOf(cause), (): BlockedTermFailure => "unexplained");
  }
}

interface BlockedTermFailureNoteProps {
  readonly failure: BlockedTermFailure | null;
  readonly fallback: string;
}

function BlockedTermFailureNote({ failure, fallback }: BlockedTermFailureNoteProps) {
  const { t } = useTranslation();

  function explain(problem: BlockedTermRequestError) {
    if (problem.error === "term-limit") {
      return t("inbox.blockedTerms.limit", { limit: maxFormBlockedTerms });
    }
    return problem.reason === "empty"
      ? t("inbox.blockedTerms.refusals.empty")
      : t("inbox.blockedTerms.refusals.tooLong", { max: maxBlockedTermLength });
  }

  if (failure === null) return null;
  return <FormProblem>{failure === "unexplained" ? fallback : explain(failure)}</FormProblem>;
}

interface BlockedTermsProps {
  readonly organizationId: string;
  readonly form: ManagedForm;
}

export function BlockedTerms({ organizationId, form }: BlockedTermsProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const query = useQuery(blockedTermsQuery(organizationId, form.publicId));
  const terms = query.isError ? null : (query.data ?? null);
  const { mutateAsync: addTerm } = useMutation(
    addBlockedTermMutation(organizationId, form.publicId),
  );
  const { mutateAsync: removeTerm } = useMutation(
    removeBlockedTermMutation(organizationId, form.publicId),
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

  const title = useId();
  return (
    <section
      aria-label={t("inbox.blockedTerms.label", { name: form.name })}
      className="grid min-w-0 grid-cols-1 content-start gap-3"
    >
      <div className="grid gap-1">
        <h2 id={title} className="flex items-baseline gap-2 font-semibold">
          {t("inbox.sections.blockedTerms")}
          {terms !== null && (
            <span className="text-sm font-normal text-muted-foreground tabular-nums">
              {terms.length}
            </span>
          )}
        </h2>
        <p className="text-xs text-pretty text-muted-foreground">
          {terms?.length === 0
            ? t("inbox.blockedTerms.empty", { limit: maxFormBlockedTerms })
            : t("inbox.blockedTerms.description", { limit: maxFormBlockedTerms })}
        </p>
      </div>
      {query.isError && (
        <ReadFailure
          cause={query.error}
          title={t("inbox.blockedTerms.loadFailed")}
          retry={t("common.retry")}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.isPending && <ChipListSkeleton label={t("inbox.blockedTerms.loading")} />}
      {terms !== null && terms.length > 0 && (
        <ul aria-labelledby={title} className="flex flex-wrap gap-1.5">
          {terms.map((item) => (
            <li key={item.term} className="max-w-full rounded-md bg-muted">
              <form action={remove} className="flex min-h-9 items-center gap-1 pr-1 pl-3">
                <code className="min-w-0 font-mono text-sm wrap-anywhere">{item.term}</code>
                <input type="hidden" name="term" value={item.term} />
                <Button
                  type="submit"
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-coarse:before:hidden"
                  aria-label={t("inbox.blockedTerms.removeLabel", { term: item.term })}
                  disabled={removing}
                >
                  <X aria-hidden="true" className="size-4" />
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <BlockedTermFailureNote
        failure={removeFailure}
        fallback={t("inbox.blockedTerms.problems.notRemoved")}
      />
      <form action={add} className="grid max-w-xl gap-2">
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label={t("inbox.blockedTerms.term")}
            className="min-w-0 flex-1 basis-48"
            name="term"
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            readOnly={adding}
            required
            maxLength={maxBlockedTermLength}
            placeholder={t("inbox.blockedTerms.placeholder")}
            autoComplete="off"
            aria-invalid={
              (addFailure !== null &&
                addFailure !== "unexplained" &&
                addFailure.error === "term-refused") ||
              undefined
            }
          />
          <Button type="submit" disabled={adding}>
            {t("inbox.blockedTerms.add")}
          </Button>
        </div>
        <BlockedTermFailureNote
          failure={addFailure}
          fallback={t("inbox.blockedTerms.problems.notAdded")}
        />
      </form>
    </section>
  );
}
