# Rondyr Oxlint rules

The plugin comes from `basaltbytes/usine@011c3f740`, which takes, among others, rules from `dmmulroy/anti-slop@6d53855`. The configuration applies Usine's React rules to the dashboard and reuses the naming and import checks of the training repository.

In `apps/rondyr/dashboard/src`, routes import features. Features can import their own code and the shared modules. The shared modules stay independent of routes and features.

`pnpm test:lint` at the repository root runs the plugin tests with Oxlint. The root `.oxlintrc.json` loads the plugin.

## Licenses

The code taken from Usine is under the GNU Affero General Public License v3.0, in [LICENSE](LICENSE).

These files come from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at commit `6d53855` and are under the MIT license, with its copyright notice, in [LICENSE-ANTI-SLOP](LICENSE-ANTI-SLOP):

- `rules/no-chained-type-assertions.ts`, `rules/no-conditional-empty-object-spread.ts`, `rules/no-known-value-widening.ts`, `rules/no-module-mocking.ts`, `rules/no-object-parameters.ts`, `rules/no-reflect-apply.ts`, `rules/no-reflect-get.ts`, `rules/no-runtime-typeof.ts`
- `rules/no-service-constructor-imports.ts`, `rules/no-shape-in-symbol-names.ts`, `rules/no-unknown-parameters.ts`, `rules/no-unknown-returns.ts`, `rules/no-unknown-type-aliases.ts`, `rules/no-unsafe-dictionary-type.ts`, `rules/no-widen-then-assert.ts`, `rules/require-safety-comment-for-type-assertion.ts`
- `shared/dictionary-types.ts`, `shared/lexical-type-parameters.ts`, `shared/reflect-method.ts`
