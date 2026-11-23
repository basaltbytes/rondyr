import { createFileRoute, redirect } from "@tanstack/react-router";

/** The settings open on their first page, the members. */
export const Route = createFileRoute("/_signed-in/o/$organizationId/settings/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/o/$organizationId/settings/members", params, replace: true });
  },
});
