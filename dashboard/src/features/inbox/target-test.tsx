import { Schema } from "effect";
import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import type { Inbox } from "~/lib/inbox-client";
import { TargetRequestFailed, testTarget } from "~/lib/targets-client";
import type { Target, TestResult } from "~/lib/targets-client";

const isFailed = Schema.is(TargetRequestFailed);

/** How a test ended: the answer of the recipient, or why the test did not run. */
type TestOutcome = TestResult | "alreadyRunning" | "limited" | "notSent";

interface TargetTestProps {
  readonly inboxId: Inbox["id"];
  readonly targetId: Target["id"];
}

/** Sends a test message to one destination and shows the answer of its recipient. */
export function TargetTest({ inboxId, targetId }: TargetTestProps) {
  const { t } = useTranslation();
  const [outcome, send, sending] = useActionState(async (): Promise<TestOutcome | null> => {
    try {
      return await testTarget(inboxId, targetId);
    } catch (error) {
      if (isFailed(error) && error.status === 409) return "alreadyRunning";
      if (isFailed(error) && error.status === 429) return "limited";
      return "notSent";
    }
  }, null);

  function describe(shown: TestOutcome) {
    if (shown === "alreadyRunning") return t("inbox.destinations.test.alreadyRunning");
    if (shown === "notSent") return t("inbox.destinations.test.notSent");
    if (shown === "limited") return t("inbox.destinations.test.limited");
    switch (shown.outcome) {
      case "delivered":
        return t("inbox.destinations.test.deliveredWithId", { id: shown.testId });
      case "retryable-failure":
        return t("inbox.destinations.test.retryableFailure", { summary: shown.summary });
      case "permanent-failure":
        return t("inbox.destinations.test.permanentFailure", { summary: shown.summary });
    }
  }

  return (
    <form action={send} className="contents">
      <Button type="submit" size="sm" disabled={sending}>
        {sending ? t("inbox.destinations.test.sending") : t("inbox.destinations.test.send")}
      </Button>
      {outcome !== null && (
        <output className="order-last basis-full text-sm wrap-anywhere text-muted-foreground">
          {describe(outcome)}
        </output>
      )}
    </form>
  );
}
