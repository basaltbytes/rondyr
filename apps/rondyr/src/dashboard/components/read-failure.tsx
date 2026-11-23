import { useTranslation } from "react-i18next";

import { FormProblem } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { readFailureOf } from "~/lib/api/request";

interface ReadFailureProps {
  /** What the request threw. */
  readonly cause: unknown;
  /** What could not be read. */
  readonly title: string;
  /** The name of the button that reads again. */
  readonly retry: string;
  readonly onRetry: () => void;
  /** The read runs again: the button waits for it. */
  readonly retrying: boolean;
  readonly className?: string;
}

/**
 * A read that failed, in place of what it would show: why, among the server that did not
 * answer, the answer that this version cannot read and the status it refused with, and a
 * button to read again. It never looks like an empty list.
 */
export function ReadFailure({
  cause,
  title,
  retry,
  onRetry,
  retrying,
  className,
}: ReadFailureProps) {
  const { t } = useTranslation();
  const failure = readFailureOf(cause);

  function explain() {
    if (failure === "unreachable") return t("common.readFailure.unreachable");
    if (failure === "unreadable") return t("common.readFailure.unreadable");
    return t("common.readFailure.status", { status: failure.status });
  }

  return (
    <div className={className}>
      <div className="grid justify-items-start gap-2">
        <FormProblem>{title}</FormProblem>
        <p className="max-w-prose text-sm text-pretty text-muted-foreground">{explain()}</p>
        <Button disabled={retrying} onClick={onRetry}>
          {retry}
        </Button>
      </div>
    </div>
  );
}
