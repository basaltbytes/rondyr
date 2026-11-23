import { createFileRoute, Navigate, notFound } from "@tanstack/react-router";

import { allows } from "@rondyr/organizations/member-role";

import { NotFoundPage } from "~/components/not-found-page";
import { FormDestinations } from "~/features/destinations/form-destinations";
import { FormPage } from "~/features/forms/form-page";
import { destinationsQuery } from "~/lib/api/destinations";
import { originsQuery } from "~/lib/api/origins";
import { requirePermission } from "~/routes/-layout/organization-access";
import { useOrganization } from "~/routes/-layout/organization-context";

/**
 * The page of a form, with its destinations, its allowed origins and Turnstile. A
 * reviewer has no page of forms.
 */
export const Route = createFileRoute("/_signed-in/o/$organizationId/forms/$publicId")({
  beforeLoad: ({ context, params }) => {
    requirePermission(context.organization, "manage-forms");
    const forms = context.organization?.forms ?? [];
    if (
      context.organization !== undefined &&
      !forms.some(({ publicId }) => publicId === params.publicId)
    ) {
      throw notFound();
    }
  },
  loader: ({ context, params }) => {
    const { organizationId, publicId } = params;
    return Promise.all([
      context.queryClient.query({
        ...destinationsQuery(organizationId, publicId),
        staleTime: "static",
      }),
      context.queryClient.query({ ...originsQuery(organizationId, publicId), staleTime: "static" }),
    ]).then(
      () => undefined,
      () => undefined,
    );
  },
  component: Form,
});

function Form() {
  const organization = useOrganization();
  const { publicId } = Route.useParams();
  const navigate = Route.useNavigate();
  const form = organization.forms.find((candidate) => candidate.publicId === publicId);
  if (!allows(organization.role, "manage-forms")) {
    return (
      <Navigate
        to="/o/$organizationId/messages"
        params={{ organizationId: organization.id }}
        replace
      />
    );
  }
  if (form === undefined) return <NotFoundPage />;
  return (
    <FormPage
      key={form.publicId}
      organizationId={organization.id}
      form={form}
      onMessages={() =>
        void navigate({
          to: "/o/$organizationId/messages",
          params: { organizationId: organization.id },
          search: { folder: "all", form: form.publicId },
        })
      }
      destinations={
        <FormDestinations
          key={`destinations-${form.publicId}`}
          organizationId={organization.id}
          form={form}
        />
      }
    />
  );
}
