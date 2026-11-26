import { Layer } from "effect";

import { apiTokenRoutes } from "./api-token-routes.ts";
import { authenticationRoutes } from "./authentication.ts";
import { blockedTermRoutes } from "./blocked-term-routes.ts";
import { classificationPolicyRoutes } from "./classification-policy-routes.ts";
import { deliveryRoutes } from "./delivery-routes.ts";
import { formRoutes } from "./form-routes.ts";
import { invitationRoutes } from "./invitation-routes.ts";
import { memberRoutes } from "./member-routes.ts";
import { operationsRoute } from "./operations-route.ts";
import { organizationDomainRoutes } from "./organization-domain-routes.ts";
import { organizationQuotaRoutes } from "./organization-quota-routes.ts";
import { originRoutes } from "./origin-routes.ts";
import { publicRoutes } from "./public-routes.ts";
import { recipientConfirmationRoutes } from "./recipient-confirmation-routes.ts";
import { reviewRoutes } from "./review-routes.ts";
import { stuckSubmissionRoutes } from "./stuck-submission-routes.ts";
import { submissionAdministrationRoutes } from "./submission-administration-routes.ts";
import { submissionRoutes } from "./submission-routes.ts";
import { targetRoutes } from "./target-routes.ts";

/**
 * Every route of the Worker. The Worker serves them behind the API token
 * middleware; a test lists them to check the rights of each one.
 */
export const routes = Layer.mergeAll(
  publicRoutes,
  authenticationRoutes,
  apiTokenRoutes,
  submissionRoutes,
  reviewRoutes,
  targetRoutes,
  originRoutes,
  blockedTermRoutes,
  organizationDomainRoutes,
  organizationQuotaRoutes,
  classificationPolicyRoutes,
  formRoutes,
  deliveryRoutes,
  memberRoutes,
  invitationRoutes,
  recipientConfirmationRoutes,
  submissionAdministrationRoutes,
  operationsRoute,
  stuckSubmissionRoutes,
);
