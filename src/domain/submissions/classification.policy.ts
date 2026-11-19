import * as Domain from "@alchemy.run/domain";
import { Effect } from "effect";

import { ClassifySubmission } from "./classify-submission.saga.ts";
import { ClassificationRequested } from "./request-classification.command.ts";
import { Submission } from "./submission.aggregate.ts";

export class Classification extends Domain.Policy(
  "Classification",
  { from: Submission, on: [ClassificationRequested] },
  { description: "Start a durable classifier run when a submission enters classification." },
) {}

export const classificationLive = Classification.toLayer(
  Effect.gen(function* () {
    const classifier = yield* ClassifySubmission;
    return Effect.fnUntraced(function* ({ source, event }) {
      yield* classifier.start(source.id, { organizationId: event.organizationId });
    });
  }),
);
