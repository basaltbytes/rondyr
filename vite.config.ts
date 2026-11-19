import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { unreachableChunksPlugin } from "alchemy/Bundle/UnreachableChunksPlugin";
import { defineConfig } from "vite";

export default defineConfig({
  define: { "globalThis.__ALCHEMY_RUNTIME__": "true" },
  build: { minify: true, rolldownOptions: { plugins: [unreachableChunksPlugin()] } },
  plugins: [
    react(),
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
    },
  },
});
