# Rondyr Oxlint rules

The plugin comes from `basaltbytes/usine@011c3f740`, which takes, among others, rules from `dmmulroy/anti-slop@6d53855`. The configuration applies Usine's React rules to the dashboard and reuses the naming and import checks of the training repository.

In `apps/rondyr/dashboard/src`, routes import features. Features can import their own code and the shared modules. The shared modules stay independent of routes and features.

`pnpm test:lint` at the repository root runs the plugin tests with Oxlint. The root `.oxlintrc.json` loads the plugin.

Redistribution of the code taken from Usine keeps its [original license](LICENSE).
