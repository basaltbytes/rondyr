import * as Domain from "@alchemy.run/domain";

import { IntakeReason } from "./classification.ts";
import { SubmissionQuarantined } from "./submission-quarantined.event.ts";
import { OrganizationId, SubmissionId } from "./submission.id.ts";

export class QuarantineAtIntake extends Domain.Command(
  "QuarantineAtIntake",
  {
    target: SubmissionId,
    input: { organizationId: OrganizationId, reason: IntakeReason },
    events: [SubmissionQuarantined],
  },
  {
    description:
      "Quarantine a durably received submission for a reason found at intake, without running the classifier.",
  },
) {}
