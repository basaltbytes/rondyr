import { useIsFetching } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { cn } from "cn";

/**
 * Thin progress bar across the top of the viewport while a navigation or an active
 * screen query is in flight. Background hover-preloads have no mounted observer, so they
 * do not trigger it, and fast cache hits finish before the fade-in delay elapses.
 */
export function GlobalLoadingBar() {
  const navigating = useRouterState({ select: (state) => state.status === "pending" });
  const fetching = useIsFetching({ predicate: (query) => query.getObserversCount() > 0 }) > 0;
  const active = navigating || fetching;

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden transition-opacity duration-200",
        active ? "opacity-100 delay-150" : "opacity-0 delay-0",
      )}
    >
      <div className="h-full w-2/5 bg-primary animate-loading-bar motion-reduce:w-full motion-reduce:animate-none" />
    </div>
  );
}
