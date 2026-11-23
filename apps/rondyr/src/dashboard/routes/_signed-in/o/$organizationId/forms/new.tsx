import { createFileRoute, Navigate } from "@tanstack/react-router";

import { allows } from "@rondyr/organizations/member-role";

import { NewFormPage } from "~/features/forms/form-page";
import { requirePermission } from "~/routes/-layout/organization-access";
import { useOrganization } from "~/routes/-layout/organization-context";

/** The creation of a form. A reviewer has no page of forms. */
export const Route = createFileRoute("/_signed-in/o/$organizationId/forms/new")({
  beforeLoad: ({ context }) => requirePermission(context.organization, "manage-forms"),
  component: NewForm,
});

function NewForm() {
  const organization = useOrganization();
  const navigate = Route.useNavigate();
  if (!allows(organization.role, "manage-forms")) {
    return (
      <Navigate
        to="/o/$organizationId/messages"
        params={{ organizationId: organization.id }}
        replace
      />
    );
  }
  return (
    <NewFormPage
      organizationId={organization.id}
      onCreated={(publicId) =>
        navigate({
          to: "/o/$organizationId/forms/$publicId",
          params: { organizationId: organization.id, publicId },
        })
      }
    />
  );
}
