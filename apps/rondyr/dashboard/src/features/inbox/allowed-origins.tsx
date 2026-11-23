import { Option, Schema } from "effect";
import { X } from "lucide-react";
import { useActionState, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { FormProblem } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { Inbox } from "~/lib/inbox-client";
import { addOrigin, listOrigins, OriginRequestFailed, removeOrigin } from "~/lib/origins-client";
import type { AllowedOrigin, OriginProblem } from "~/lib/origins-client";

const isFailed = Schema.is(OriginRequestFailed);

/** Why a request to the origins API failed: the problem that the API names, or no stated reason. */
type OriginFailure = OriginProblem | "unexplained";

/** Run a request and return why it failed, or null. */
async function attempt(request: () => Promise<void>): Promise<OriginFailure | null> {
  try {
    await request();
    return null;
  } catch (error) {
    if (!isFailed(error)) return "unexplained";
    return Option.match(error.problem, {
      onNone: (): OriginFailure => "unexplained",
      onSome: (problem): OriginFailure => problem,
    });
  }
}

interface OriginFailureNoteProps {
  readonly failure: OriginFailure | null;
  /** The message for a failure that the API does not explain. */
  readonly fallback: string;
}

function OriginFailureNote({ failure, fallback }: OriginFailureNoteProps) {
  const { t } = useTranslation();

  function explain(problem: OriginProblem) {
    return problem.error === "origin-in-use"
      ? t("inbox.origins.inUse")
      : t(`inbox.origins.refusals.${problem.reason}`);
  }

  if (failure === null) return null;
  return <FormProblem>{failure === "unexplained" ? fallback : explain(failure)}</FormProblem>;
}

interface AllowedOriginsProps {
  readonly inboxId: Inbox["id"];
  readonly form: Inbox["forms"][number];
}

export function AllowedOrigins({ inboxId, form }: AllowedOriginsProps) {
  const { t } = useTranslation();
  const [origins, setOrigins] = useState<readonly AllowedOrigin[] | null>(null);
  const [failed, setFailed] = useState(false);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the form's allowed origins from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listOrigins(inboxId, form.publicId, request.signal).then(setOrigins, () => {
      if (!request.signal.aborted) setFailed(true);
    });
    return () => request.abort();
  }, [inboxId, form.publicId]);

  const [addFailure, add, adding] = useActionState((_: OriginFailure | null, data: FormData) => {
    const origin = data.get("origin")?.toString() ?? "";
    return attempt(async () => {
      const added = await addOrigin(inboxId, form.publicId, origin);
      setOrigins((current) => {
        const kept = current ?? [];
        return kept.some((item) => item.origin === added.origin) ? kept : [...kept, added];
      });
    });
  }, null);

  const [removeFailure, remove, removing] = useActionState(
    (_: OriginFailure | null, data: FormData) => {
      const origin = data.get("origin")?.toString() ?? "";
      return attempt(async () => {
        await removeOrigin(inboxId, form.publicId, origin);
        setOrigins((current) => current?.filter((item) => item.origin !== origin) ?? null);
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
      {failed && <FormProblem>{t("inbox.origins.loadFailed")}</FormProblem>}
      {origins === null && !failed && (
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
