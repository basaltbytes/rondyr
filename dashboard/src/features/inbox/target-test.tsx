import { Schema } from "effect";
import { useActionState } from "react";

import { Button } from "~/components/ui/button";
import type { Inbox } from "~/lib/inbox-client";
import { TargetRequestFailed, testTarget } from "~/lib/targets-client";
import type { Target, TestResult } from "~/lib/targets-client";

const isFailed = Schema.is(TargetRequestFailed);

function describe(result: TestResult) {
  switch (result.outcome) {
    case "delivered":
      return `Message d’essai livré, identifiant ${result.testId}.`;
    case "retryable-failure":
      return `Échec temporaire du message d’essai : ${result.summary}`;
    case "permanent-failure":
      return `Échec du message d’essai : ${result.summary}`;
  }
}

interface TargetTestProps {
  readonly inboxId: Inbox["id"];
  readonly targetId: Target["id"];
}

/** Sends a test message to one destination and shows the answer of its recipient. */
export function TargetTest({ inboxId, targetId }: TargetTestProps) {
  const [result, send, sending] = useActionState(async () => {
    try {
      return describe(await testTarget(inboxId, targetId));
    } catch (error) {
      if (isFailed(error) && error.status === 409) {
        return "Un essai est déjà en cours pour cette destination.";
      }
      return "Le message d’essai n’a pas pu être envoyé. Réessayez.";
    }
  }, null);

  return (
    <form action={send} className="contents">
      <Button type="submit" size="sm" disabled={sending}>
        {sending ? "Envoi de l’essai…" : "Envoyer un essai"}
      </Button>
      {result !== null && (
        <output className="order-last basis-full text-sm wrap-anywhere text-muted-foreground">
          {result}
        </output>
      )}
    </form>
  );
}
