import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import { RootErrorPage } from "~/components/error-page";
import { GlobalLoadingBar } from "~/components/global-loading-bar";

/** What every route can read: the cache of the dashboard. */
interface RouterContext {
  readonly queryClient: QueryClient;
}

function RootLayout() {
  return (
    <>
      <GlobalLoadingBar />
      <Outlet />
    </>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  errorComponent: RootErrorPage,
  component: RootLayout,
});
