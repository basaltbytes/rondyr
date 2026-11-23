import { useMutation } from "@tanstack/react-query";
import { Option } from "effect";
import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import {
  destinationRefusalOf,
  testDestination,
  type DestinationTarget,
  type TargetTestResult,
} from "~/lib/api/destinations";
import { statusOf } from "~/lib/api/request";

/** How a test ended: the answer of the recipient, or why the test did not run. */
type TestOutcome = TargetTestResult | "alreadyRunning" | "limited" | "limitUnavailable" | "notSent";

interface DestinationTestProps {
  readonly organizationId: string;
  readonly targetId: DestinationTarget["id"];
}

/** Sends a test message to one destination and shows the answer of its recipient. */
export function DestinationTest({ organizationId, targetId }: DestinationTestProps) {
  const { t } = useTranslation();
  const { mutateAsync: test } = useMutation({
    mutationFn: () => testDestination(organizationId, targetId),
  });
  const [outcome, send, sending] = useActionState(async (): Promise<TestOutcome | null> => {
    try {
      return await test();
    } catch (cause) {
      if (statusOf(cause) === 409) return "alreadyRunning";
      if (statusOf(cause) === 429) return "limited";
      const refusal = destinationRefusalOf(cause);
      if (Option.isSome(refusal) && refusal.value.error === "test-limit-unavailable") {
        return "limitUnavailable";
      }
      return "notSent";
    }
  }, null);

  function describe(shown: TestOutcome) {
    if (shown === "alreadyRunning") return t("inbox.destinations.test.alreadyRunning");
    if (shown === "notSent") return t("inbox.destinations.test.notSent");
    if (shown === "limited") return t("inbox.destinations.test.limited");
    if (shown === "limitUnavailable") return t("inbox.destinations.test.limitUnavailable");
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
