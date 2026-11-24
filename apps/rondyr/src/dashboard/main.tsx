import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import "~/lib/i18n";
import { ErrorBoundary } from "~/components/error-boundary";
import { RouteError } from "~/components/error-page";
import { NotFoundPage } from "~/components/not-found-page";
import { PagePending } from "~/components/page-pending";
import type { SidebarSection } from "~/features/navigation/sidebar-page";
import { sessionQuery } from "~/lib/api/session";
import { statusOf } from "~/lib/api/request";
import { parseSearch, stringifySearch } from "~/lib/search-params";

import { routeTree } from "./route-tree.gen.ts";

import "./dashboard.css";

/**
 * An answer that says the session ended, while the dashboard is open, empties the cache
 * and opens the sign-in form, which comes back to the same address. Every answer after
 * the first one finds the session already gone.
 */
function signInAgain(cause: Error) {
  if (statusOf(cause) !== 401) return;
  if (queryClient.getQueryData(sessionQuery.queryKey) === null) return;
  if (!router.state.matches.some(({ routeId }) => routeId === "/_signed-in")) return;
  const redirect = router.state.location.href;
  queryClient.clear();
  queryClient.setQueryData(sessionQuery.queryKey, null);
  void router.navigate({
    to: "/sign-in",
    search: { redirect },
    replace: true,
    state: { sessionEnded: true },
  });
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: signInAgain }),
  mutationCache: new MutationCache({ onError: signInAgain }),
  defaultOptions: {
    queries: {
      // A screen shows a failed read at once, with a button to read again.
      retry: false,
      retryOnMount: false,
      // Data read on navigation or hover-preload stays fresh briefly so switching screens is instant.
      staleTime: 30_000,
      // Nothing is read again because the window regains focus.
      refetchOnWindowFocus: false,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  // Warm both the code-split route chunk and its queries as soon as the pointer or focus reaches a link.
  defaultPreload: "intent",
  // Let TanStack Query own freshness rather than caching preloaded loaders separately.
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  // Every value of the dashboard's search params is a text, written as it is.
  parseSearch,
  stringifySearch,
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: NotFoundPage,
  defaultPendingComponent: PagePending,
  defaultPendingMs: 200,
  defaultPendingMinMs: 200,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    /** The page that the sidebar marks while the route is open; the routes under it inherit it. */
    sidebar?: SidebarSection;
  }
  interface HistoryState {
    /** The organization whose sidebar the creation of another one shows. */
    organizationId?: string;
    /** The sign-in page opens because the API answered that the session ended. */
    sessionEnded?: boolean;
  }
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>,
  );
}
