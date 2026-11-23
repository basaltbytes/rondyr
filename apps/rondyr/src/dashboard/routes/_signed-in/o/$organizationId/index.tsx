import { createFileRoute, redirect } from "@tanstack/react-router";

/** The address of an organization opens its messages. */
export const Route = createFileRoute("/_signed-in/o/$organizationId/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/o/$organizationId/messages", params, replace: true });
  },
});
