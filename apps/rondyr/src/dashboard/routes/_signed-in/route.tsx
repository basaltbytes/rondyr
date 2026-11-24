import { createFileRoute, redirect } from "@tanstack/react-router";

import { AppShellSkeleton } from "~/components/page-pending";
import { sessionQuery } from "~/lib/api/session";

/**
 * Every page of the dashboard needs a session. A visitor without one goes to the sign-in
 * page with the address they asked for, before the page loads anything.
 */
export const Route = createFileRoute("/_signed-in")({
  pendingComponent: AppShellSkeleton,
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient
      .query({ ...sessionQuery, staleTime: "static" })
      .catch(() => null);
    if (session === null) {
      throw redirect({
        to: "/sign-in",
        search: location.href === "/" ? {} : { redirect: location.href },
      });
    }
    return { user: session.user };
  },
});
