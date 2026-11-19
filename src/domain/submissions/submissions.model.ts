import * as Domain from "@alchemy.run/domain";
import { Layer } from "effect";

import { Classification, classificationLive } from "./classification.policy.ts";
import { ClassifySubmission, classifySubmissionLive } from "./classify-submission.saga.ts";
import { GetSubmission, getSubmissionLive } from "./get-submission.query.ts";
import { Inbox, inboxLive } from "./inbox.projection.ts";
import { ListSubmissions, listSubmissionsLive } from "./list-submissions.query.ts";
import { Submission } from "./submission.aggregate.ts";

export class Submissions extends Domain.Model(
  "Submissions",
  {
    aggregates: [Submission],
    policies: [Classification],
    sagas: [ClassifySubmission],
    projections: [Inbox],
    queries: [ListSubmissions, GetSubmission],
  },
  { description: "Durable classification and human review of Rondyr form submissions." },
) {}

export const submissionHandlers = Layer.mergeAll(
  classificationLive,
  classifySubmissionLive,
  inboxLive,
  listSubmissionsLive,
  getSubmissionLive,
);
