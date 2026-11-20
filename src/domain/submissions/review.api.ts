import * as Domain from "@alchemy.run/domain";

import { Submissions } from "./submissions.model.ts";

export class ReviewApi extends Domain.Api(
  "ReviewApi",
  {
    model: Submissions,
    commands: ["ApproveSubmission", "DismissSubmission"],
    queries: ["ListSubmissions", "GetSubmission", "CountSubmissions"],
  },
  { description: "Read and review messages within an authenticated organization inbox." },
) {}
