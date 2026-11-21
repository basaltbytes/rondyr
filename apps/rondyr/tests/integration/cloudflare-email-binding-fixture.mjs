// A wrapped binding preserves the coded Error in the calling Worker. RPC
// exceptions from the fixture would lose their custom `code` property.
const binding = `
export default function ({ fixture }) {
  return {
    async send(message) {
      const response = await fixture.fetch("https://email.test/send", {
        method: "POST",
        body: JSON.stringify(message),
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.message), { code: result.code });
      return result;
    },
  };
}
`;

export const plugins = {
  "rondyr-email-fixture": {
    getBindings({ config }) {
      if (config.env?.CLOUDFLARE_EMAIL?.type !== "unsafe:rondyr-email-fixture") return [];
      return [
        {
          name: "CLOUDFLARE_EMAIL",
          wrapped: {
            moduleName: "rondyr-email-fixture:binding",
            innerBindings: [
              { name: "fixture", service: { name: "core:user:cloudflare-email-fixture" } },
            ],
          },
        },
      ];
    },
    getExtensions: () => [
      { modules: [{ name: "rondyr-email-fixture:binding", esModule: binding, internal: true }] },
    ],
    getNodeBindings: () => ({}),
    getServices: () => [],
  },
};
