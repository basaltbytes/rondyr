---
name: rondyr-cloudflare
description: Work on Rondyr's Cloudflare Worker, Alchemy stack, D1 migrations, bindings, static assets, or workerd tests.
---

# Cloudflare in Rondyr

The root `wrangler.json` defines the Worker and its resources: the Deploy to Cloudflare button, `pnpm run deploy`, Vite, type generation, Vitest and Playwright read it, the tools of `apps/rondyr/` through `worker-config.ts`. `apps/rondyr/alchemy-run.ts` deploys the Basaltbytes production from it until that production moves to Wrangler. Check both when a binding changes; `pnpm doctor` compares them. A build leaves `apps/rondyr/.wrangler/deploy/config.json`, so a Wrangler command run in `apps/rondyr/` names its configuration with `-c`. Alchemy injects its Vite plugin into its own runs. Respect the `ALCHEMY_CLOUDFLARE_VITE_INJECTED` guard in the Vite configuration.

The headers of the dashboard assets are in `apps/rondyr/public/_headers`. Vite copies the file to `apps/rondyr/dist/client`, and Alchemy and Wrangler both apply it to the assets, not to the Worker's responses. Keep the Cloudflare APIs in the adapters and the entry points. Describe the services that the business logic uses with Effect, and expose errors through Effect's typed channel.

- `pnpm dev` starts Vite and workerd. After a D1 change, run `pnpm db:migrate` on the local database.
- `pnpm dev:alchemy` exercises the local graph and applies the migrations to the Alchemy database. The state of the remote stages is in Cloudflare.
- `pnpm db:generate --name your-migration-name` generates the SQL and the schema snapshot. Add a migration to change a schema that is already applied.
- `pnpm test` uses the real Workers runtime locally. `pnpm deploy:dry` validates the build and the Worker configuration without credentials.

The root scripts run these commands in `apps/rondyr/`, the package `rondyr`, so the relative paths of the stack (`./database/migrations`, `./dist/client`, `--env-file`, `.alchemy/`) resolve there. Run any other Alchemy or Wrangler command with `pnpm --filter rondyr exec`. The Alchemy stack uses an explicit stage for a remote deployment. Check the Cloudflare profile before a requested deployment. The first Alchemy plan can offer to provision its state Worker. See the README for the commands.
