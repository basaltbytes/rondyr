import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { unreachableChunksPlugin } from "alchemy/Bundle/UnreachableChunksPlugin";
import { defineConfig } from "vite";

export default defineConfig({
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
                {
                  name: "auth",
                  test: /node_modules\/(?:better-auth|@better-auth|better-call|@better-fetch|nanostores)\//,
                },
                { name: "i18n", test: /node_modules\/(?:i18next|react-i18next)\// },
              ],
            },
          },
        },
      },
    },
  },
  plugins: [
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
    process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1" ? undefined : cloudflare(),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@rondyr/contracts": fileURLToPath(new URL("./src/domain/submissions", import.meta.url)),
      "@rondyr/deliveries": fileURLToPath(new URL("./src/domain/deliveries", import.meta.url)),
      "@rondyr/forms": fileURLToPath(new URL("./src/domain/forms", import.meta.url)),
      "@rondyr/organizations": fileURLToPath(
        new URL("./src/domain/organizations", import.meta.url),
      ),
    },
  },
});
