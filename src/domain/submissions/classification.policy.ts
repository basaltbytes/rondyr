import * as Domain from "@alchemy.run/domain";
import { Effect } from "effect";

import { ClassificationRunId, ClassifySubmission } from "./classify-submission.saga.ts";
import { ReclassificationRequested } from "./reclassify-submission.command.ts";
import { ClassificationRequested } from "./request-classification.command.ts";
import { Submission } from "./submission.aggregate.ts";

export class Classification extends Domain.Policy(
  "Classification",
  { from: Submission, on: [ClassificationRequested, ReclassificationRequested] },
  { description: "Start a durable classifier run when a submission enters classification." },
) {}

export const classificationLive = Classification.toLayer(
  Effect.gen(function* () {
    const classifier = yield* ClassifySubmission;
    return Effect.fnUntraced(function* ({ source, event, envelope }) {
      // A saga started again with the same key returns its first run, so each
      // reclassification gets its own key, from the sequence number of its event.
      const run =
        event._tag === "ClassificationRequested"
          ? ClassificationRunId.make(source.id)
          : ClassificationRunId.make(`${source.id}/${envelope.seq}`);
      yield* classifier.start(run, {
        organizationId: event.organizationId,
        submissionId: source.id,
      });
    });
  }),
);
