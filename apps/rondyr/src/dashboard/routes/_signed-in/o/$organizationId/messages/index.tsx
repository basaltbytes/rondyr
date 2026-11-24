import { createFileRoute } from "@tanstack/react-router";

import { ReaderPlaceholder } from "~/features/messages/reader-placeholder";

/** The list without an open message. */
export const Route = createFileRoute("/_signed-in/o/$organizationId/messages/")({
  component: NoOpenMessage,
});

function NoOpenMessage() {
  const { organizationId } = Route.useParams();
  return <ReaderPlaceholder organizationId={organizationId} />;
}
