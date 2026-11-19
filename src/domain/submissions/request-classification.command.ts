import * as Domain from "@alchemy.run/domain";

import { OrganizationId, SubmissionId } from "./submission.id.ts";

export class ClassificationRequested extends Domain.Event("ClassificationRequested", {
  organizationId: OrganizationId,
}) {}

export class RequestClassification extends Domain.Command(
  "RequestClassification",
  {
    target: SubmissionId,
    input: { organizationId: OrganizationId },
    events: [ClassificationRequested],
  },
  { description: "Start classification of a durably received submission." },
) {}
