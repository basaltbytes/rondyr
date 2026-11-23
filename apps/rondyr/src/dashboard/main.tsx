import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import "~/lib/i18n";
import { NotFoundPage } from "~/components/not-found-page";
import { PagePending } from "~/components/page-pending";
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

// When the current navigation started: the reads of its loaders are the reads of its pages.
let navigatedAt = 0;

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: signInAgain }),
  mutationCache: new MutationCache({ onError: signInAgain }),
  defaultOptions: {
    queries: {
      // A screen shows a failed read at once, with a button to read again.
      retry: false,
      retryOnMount: false,
      // A screen reads its data again when it opens, unless its loader has just read it.
      refetchOnMount: (query) => query.state.dataUpdatedAt < navigatedAt,
      // Nothing is read again because the window regains focus.
      refetchOnWindowFocus: false,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  // Every value of the dashboard's search params is a text, written as it is.
  parseSearch,
  stringifySearch,
  defaultNotFoundComponent: NotFoundPage,
  defaultPendingComponent: PagePending,
});

router.subscribe("onBeforeNavigate", () => {
  navigatedAt = Date.now();
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
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
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
