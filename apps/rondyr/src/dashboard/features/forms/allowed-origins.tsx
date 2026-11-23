import { useMutation, useQuery } from "@tanstack/react-query";
import { Option } from "effect";
import { X } from "lucide-react";
import { useActionState, useId } from "react";
import { useTranslation } from "react-i18next";

import { ReadFailure } from "~/components/read-failure";
import { FormProblem } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { ManagedForm } from "~/lib/api/forms";
import {
  addOriginMutation,
  originRefusalOf,
  originsQuery,
  removeOriginMutation,
  type OriginRequestError,
} from "~/lib/api/origins";

/** Why a request to the origins API failed: the problem that the API names, or no stated reason. */
type OriginFailure = OriginRequestError | "unexplained";

/** Run a request and return why it failed, or null. */
async function attempt(request: () => Promise<void>): Promise<OriginFailure | null> {
  try {
    await request();
    return null;
  } catch (cause) {
    return Option.getOrElse(originRefusalOf(cause), (): OriginFailure => "unexplained");
  }
}

interface OriginFailureNoteProps {
  readonly failure: OriginFailure | null;
  /** The message for a failure that the API does not explain. */
  readonly fallback: string;
}

function OriginFailureNote({ failure, fallback }: OriginFailureNoteProps) {
  const { t } = useTranslation();

  function explain(problem: OriginRequestError) {
    return problem.error === "origin-in-use"
      ? t("inbox.origins.inUse")
      : t(`inbox.origins.refusals.${problem.reason}`);
  }

  if (failure === null) return null;
  return <FormProblem>{failure === "unexplained" ? fallback : explain(failure)}</FormProblem>;
}

interface AllowedOriginsProps {
  readonly organizationId: string;
  readonly form: ManagedForm;
}

export function AllowedOrigins({ organizationId, form }: AllowedOriginsProps) {
  const { t } = useTranslation();
  const query = useQuery(originsQuery(organizationId, form.publicId));
  const origins = query.isError ? null : (query.data ?? null);
  const { mutateAsync: addOrigin } = useMutation(addOriginMutation(organizationId, form.publicId));
  const { mutateAsync: removeOrigin } = useMutation(
    removeOriginMutation(organizationId, form.publicId),
  );

  const [addFailure, add, adding] = useActionState((_: OriginFailure | null, data: FormData) => {
    const origin = data.get("origin")?.toString() ?? "";
    return attempt(async () => {
      await addOrigin(origin);
    });
  }, null);

  const [removeFailure, remove, removing] = useActionState(
    (_: OriginFailure | null, data: FormData) => {
      const origin = data.get("origin")?.toString() ?? "";
      return attempt(async () => {
        await removeOrigin(origin);
      });
    },
    null,
  );

  const title = useId();
  return (
    <section
      aria-label={t("inbox.origins.label", { name: form.name })}
      className="grid min-w-0 grid-cols-1 content-start gap-3"
    >
      <div className="grid gap-1">
        <h2 id={title} className="flex items-baseline gap-2 font-semibold">
          {t("inbox.sections.origins")}
          {origins !== null && (
            <span className="text-sm font-normal text-muted-foreground tabular-nums">
              {origins.length}
            </span>
          )}
        </h2>
        <p className="text-xs text-pretty text-muted-foreground">
          {origins?.length === 0 ? t("inbox.origins.empty") : t("inbox.origins.description")}
        </p>
      </div>
      {query.isError && (
        <ReadFailure
          cause={query.error}
          title={t("inbox.origins.loadFailed")}
          retry={t("common.retry")}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.isPending && (
        <output className="text-sm text-muted-foreground">{t("inbox.origins.loading")}</output>
      )}
      {origins !== null && origins.length > 0 && (
        <ul aria-labelledby={title} className="grid grid-cols-1 gap-1.5">
          {origins.map((item) => (
            <li key={item.origin} className="min-w-0 rounded-md bg-muted">
              <form action={remove} className="flex min-h-11 items-center gap-2 pr-1.5 pl-4">
                <code className="min-w-0 flex-1 font-mono text-sm wrap-anywhere">
                  {item.origin}
                </code>
                <input type="hidden" name="origin" value={item.origin} />
                <Button
                  type="submit"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("inbox.origins.removeLabel", { origin: item.origin })}
                  disabled={removing}
                >
                  <X aria-hidden="true" className="size-4" />
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <OriginFailureNote
        failure={removeFailure}
        fallback={t("inbox.origins.problems.notRemoved")}
      />
      <form action={add} className="grid gap-2">
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label={t("inbox.origins.origin")}
            className="min-w-0 flex-1 basis-48"
            type="url"
            name="origin"
            required
            maxLength={2048}
            placeholder={t("inbox.origins.placeholder")}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" disabled={adding}>
            {t("inbox.origins.add")}
          </Button>
        </div>
        <OriginFailureNote failure={addFailure} fallback={t("inbox.origins.problems.notAdded")} />
      </form>
    </section>
  );
}
