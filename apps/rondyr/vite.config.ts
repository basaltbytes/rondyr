import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { cloudflare } from "@cloudflare/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { unreachableChunksPlugin } from "alchemy/Bundle/UnreachableChunksPlugin";
import { defineConfig } from "vite";

import { queueNameVars, wranglerConfigPath } from "./worker-config.ts";

/**
 * The secrets of local development, from apps/rondyr/.env. Wrangler would read a .env
 * next to the root wrangler.json, which the Deploy to Cloudflare button also reads.
 * scripts/dev-server-check.mjs names another file with RONDYR_DEV_ENV_FILE.
 */
function localSecrets(): Record<string, string> {
  const file = process.env.RONDYR_DEV_ENV_FILE ?? fileURLToPath(new URL(".env", import.meta.url));
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    Object.entries(parseEnv(readFileSync(file, "utf8"))).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export default defineConfig(({ command }) => ({
  define: { "globalThis.__ALCHEMY_RUNTIME__": "true" },
  build: { minify: true, rolldownOptions: { plugins: [unreachableChunksPlugin()] } },
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: {
            // The libraries of the dashboard change less often than its own code and are
            // too large for one file together, so each family has its own chunk.
            codeSplitting: {
              groups: [
                { name: "react", test: /node_modules\/(?:react|react-dom|scheduler)\// },
                { name: "effect", test: /node_modules\/effect\// },
                { name: "i18n", test: /node_modules\/(?:i18next|react-i18next)\// },
                { name: "tanstack", test: /node_modules\/@tanstack\// },
              ],
            },
          },
        },
      },
    },
  },
  plugins: [
    // The routes of the dashboard are the files of src/dashboard/routes. The plugin writes
    // their tree to route-tree.gen.ts and loads the component of each route on its own.
    tanstackRouter({
      target: "react",
      routesDirectory: "./src/dashboard/routes",
      generatedRouteTree: "./src/dashboard/route-tree.gen.ts",
      autoCodeSplitting: true,
      plugin: { vite: { environmentName: "client" } },
    }),
    react(),
    tailwindcss(),
    babel({
      presets: [
        reactCompilerPreset({
          target: "19",
          panicThreshold: "all_errors",
          environment: { validateNoSetStateInEffects: true },
        }),
      ],
    }),
    // Alchemy injects its own plugin with the bindings resolved for the selected stage.
    process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1"
      ? undefined
      : cloudflare({
          configPath: wranglerConfigPath,
          // .wrangler/state, unless scripts/dev-server-check.mjs runs on a database of its own.
          persistState:
            process.env.RONDYR_DEV_STATE === undefined
              ? true
              : { path: process.env.RONDYR_DEV_STATE },
          config: (worker) => {
            const queueNames = queueNameVars(worker.queues);
            if (command !== "serve") return { vars: { ...queueNames } };
            // Workers AI only runs on Cloudflare: local development goes without the
            // binding and needs no Cloudflare account; a classification ends in quarantine.
            worker.ai = undefined;
            return { vars: { ...queueNames, ...localSecrets() } };
          },
        }),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@rondyr/brand": fileURLToPath(new URL("../../docs/brand", import.meta.url)),
      "@rondyr/contracts": fileURLToPath(new URL("./src/domain/submissions", import.meta.url)),
      "@rondyr/deliveries": fileURLToPath(new URL("./src/domain/deliveries", import.meta.url)),
      "@rondyr/forms": fileURLToPath(new URL("./src/domain/forms", import.meta.url)),
      "@rondyr/organizations": fileURLToPath(
        new URL("./src/domain/organizations", import.meta.url),
      ),
    },
  },
}));
