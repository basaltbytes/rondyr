---
name: react-app-structure
description: Organize React routes, features, shared components, hooks, and HTTP clients in Rondyr's Vite dashboard.
---

# React dashboard

The routes in `apps/rondyr/dashboard/src/routes` compose the features in `apps/rondyr/dashboard/src/features`. A feature can import its own modules and the shared folders `components`, `hooks` and `lib`. The shared folders stay independent of routes and features.

Use named exports. Import modules of the current folder with a relative path and those of the rest of the dashboard through `~/`. Go through HTTP to reach the Worker. No interface text is written in a component: each text is an i18next key, in English in `locales/en/translation.json` and in French in `locales/fr/translation.json`, read with `useTranslation()`. Both files have the same keys, which the typing of `lib/i18n.ts` checks. `pnpm i18n:check` reports a hard-coded text and a key missing from the files.

Oxlint checks imports, manual memoization calls and React effects. If an effect synchronizes an external API, name that API in the exception comment the rule asks for. Test computations independently of the DOM, and check interactions in the browser when they depend on it.
