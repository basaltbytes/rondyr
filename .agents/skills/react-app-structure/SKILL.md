---
name: react-app-structure
description: Organize the routes, features, shared components, hooks, queries and HTTP clients of Rondyr's dashboard, in apps/rondyr/src/dashboard.
---

# React dashboard

The dashboard is `apps/rondyr/src/dashboard`. It runs in the browser, imports the domain of `apps/rondyr/src/domain` through the `@rondyr/*` aliases, and imports nothing of `apps/rondyr/src/worker`: it reaches the Worker through HTTP. Oxlint checks these boundaries.

## Folders

- `routes/` has one file per address, in TanStack Router's file naming: `__root.tsx`, `$param` folders with a `route.tsx`, `index.tsx` for the address of a folder, and `_signed-in/` for the pathless layout that checks the session. A folder that starts with `-` is left out of the route tree: `routes/-layout/` has what several routes share, such as the sidebar layout of an organization and the checks of a role. A page of an organization declares the page that the sidebar marks in `staticData: { sidebar: … }`, typed by the `StaticDataRouteOption` augmentation of `main.tsx`; the layout reads it from the deepest open route that has one, and takes the folder and the form from the address. The Vite plugin writes the tree to `route-tree.gen.ts`, which Oxlint, the formatter and Knip ignore; `pnpm build` or `pnpm dev` writes it again after a route is added, before `pnpm typecheck` can see the route.
- `features/<subject>/` has the screens of one subject: `messages`, `forms`, `destinations`, `organization`, `navigation`, `operations`, `authentication`, `recipients`.
- `components/` has `ui/` (shadcn/ui on Base UI, `base-nova` in `components.json`) and what several features show, such as the form emoji and the state of a failed read.
- `hooks/` and `lib/` are shared. `lib/api/` has the HTTP clients.

A route composes features: it gives a feature what another feature shows, such as the destinations of the form page or the account menu of the sidebar. A feature imports its own modules and `components`, `hooks` and `lib`, never another feature, and never receives another feature from inside a feature. The shared folders import neither features nor routes. Import a module of the current folder with a relative path and any other through `~/`.

## Reading and writing

Every request goes through `request` or `requestJson` of `lib/api/request.ts`. A refused request throws `RequestFailed`, with the status and, when the client gives the schema of the API's refusal, the refusal it decoded; `refusalOf` reads it back with that schema, and `readFailureOf` tells a server that did not answer from an answer that does not decode and from a status. Each client decodes the answers with the domain's schemas and exports its query options and its mutation options next to its functions. The key of a query of an organization's data starts with the organization ID.

A route's `loader` kicks off the reads of its page without blocking navigation (`void queryClient.query(options).catch(() => undefined)`), and the router preloads code and data on pointer/focus intent (`defaultPreload: "intent"`, `defaultPreloadStaleTime: 0`) so switching screens feels instant; the page reads data with `useQuery` and shows its own loading state if a cold read is still in flight. Only auth/access guards in `beforeLoad` (using `staleTime: "static"` once loaded) and deep links that may return `404` (`notFound()`) await in the router. A failed read shows `ReadFailure` with a button that reads again, never an empty list. A write is a mutation whose options update or invalidate the queries it changed; its button is disabled while it runs. The counts of the messages change in the cache after a decision or a deletion, and only Refresh, a reload and a change of organization count again. Queries stay fresh briefly (`staleTime: 30_000`) so hover-preloads and switching between screens avoid redundant fetches, and nothing is read again when the window regains focus. An answer `401` clears the cache and opens `/sign-in` with the address to come back to.

The search params of an address are decoded by an Effect schema passed to `validateSearch` with `Schema.toStandardSchemaV1`. A refused value gives way to its default, or to `undefined`: the router keeps the params that a schema leaves out.

## Effects and texts

No effect calls the API. Oxlint checks manual memoization calls and React effects: an effect that synchronizes an outside system, such as a listener of the window's keyboard, names that system in the exception comment that `rondyr/no-unreasoned-effect` asks for. The React Compiler runs with `panicThreshold: "all_errors"`.

Use named exports, and name a file after what it exports. A type that comes from a domain schema has the name of the schema; a component, a file, a route and a query key use the word of the English locale, such as message and destination. No interface text is written in a component: each text is an i18next key, in English in `locales/en/translation.json` and in French in `locales/fr/translation.json`, read with `useTranslation()`. Both files have the same keys, which the typing of `lib/i18n.ts` checks. `pnpm i18n:check` reports a hard-coded text and a key missing from the files.

Test computations independently of the DOM, in `*.test.ts` files next to them, which Vitest runs in Node. Check interactions in the browser with the Playwright tests of `apps/rondyr/tests/e2e`, which take their labels from the locale files.
