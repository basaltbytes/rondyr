import { createFileRoute, notFound } from "@tanstack/react-router";

import { MessageReader } from "~/features/messages/message-reader";
import { deliveriesQuery } from "~/lib/api/deliveries";
import { messageListQuery, messageQuery } from "~/lib/api/messages";
import { statusOf } from "~/lib/api/request";
import { useOrganization } from "~/routes/-layout/organization-context";

/**
 * A message, beside the list it was opened from. The list has its preview, which shows
 * until the full fields arrive; a message that the list does not have waits for them.
 */
export const Route = createFileRoute("/_signed-in/o/$organizationId/messages/$submissionId")({
  loaderDeps: ({ search }) => search,
  loader: async ({ context, params, deps }) => {
    const { queryClient } = context;
    const { organizationId, submissionId } = params;
    const detail = messageQuery(organizationId, submissionId);
    const listed = queryClient
      .getQueryData(messageListQuery(organizationId, deps).queryKey)
      ?.pages.flatMap(({ entries }) => entries)
      .find((entry) => entry.submissionId === submissionId);
    if (listed !== undefined) {
      void queryClient.query(detail).catch(() => undefined);
      if (listed.status === "accepted") {
        void queryClient
          .query(deliveriesQuery(organizationId, submissionId))
          .catch(() => undefined);
      }
      return;
    }
    await queryClient.query({ ...detail, staleTime: "static" }).catch((cause: unknown) => {
      // A message that does not exist, or no longer does, has no page.
      if (statusOf(cause) === 404) throw notFound();
    });
  },
  component: OpenMessage,
});

function OpenMessage() {
  const organization = useOrganization();
  const { submissionId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <MessageReader
      key={submissionId}
      organization={organization}
      submissionId={submissionId}
      search={search}
      onOpen={(next, replace) =>
        void (next === null
          ? navigate({ to: "/o/$organizationId/messages", search, replace })
          : navigate({
              to: "/o/$organizationId/messages/$submissionId",
              params: { submissionId: next },
              search,
              replace,
            }))
      }
    />
  );
}
