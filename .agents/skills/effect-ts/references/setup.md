# Effect setup in Rondyr

Check `package.json` for the Effect version and keep the platform and test packages at the same version. Effect 4 exposes HTTP through `effect/http` and uses the Effect diagnostics configuration in `tsconfig.json`.

- `pnpm typecheck` generates the Workers types, then runs `effect-tsgo tsc`. The launcher adds the diagnostics without modifying the installed binaries.
- Build the code with Vite and keep the TypeScript `Bundler` resolution. Check the TypeScript version selected in the editor.
- Use `@effect/vitest` for Effect tests. The Cloudflare tests run on workerd through `@cloudflare/vitest-plugin`.
- For the Worker lifecycle and D1, read the [project's Cloudflare skill](../../rondyr-cloudflare/SKILL.md).
