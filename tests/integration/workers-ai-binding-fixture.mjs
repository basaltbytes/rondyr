// Wrap the local inference service with workerd's AI API. A Worker RPC stub
// cannot receive the AbortSignal passed to Ai.run.
export const plugins = {
  "rondyr-ai-fixture": {
    getBindings({ config }) {
      if (config.env?.AI?.type !== "unsafe:rondyr-ai-fixture") return [];
      return [
        {
          name: "AI",
          wrapped: {
            moduleName: "cloudflare-internal:ai-api",
            innerBindings: [{ name: "fetcher", service: { name: "core:user:workers-ai-fixture" } }],
          },
        },
      ];
    },
    getNodeBindings: () => ({}),
    getServices: () => [],
  },
};
