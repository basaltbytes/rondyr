// AI Gateway creates the gateway named `default` on an account's first
// authenticated request, with log collection on. Workers AI sends the calls of
// both classifiers through it: Jev calls made with the binding appeared in its
// logs, with the submission fields, before they passed these options. Each call
// turns log collection and the cache off for itself, whatever the gateway setting.
export const aiGatewayOptions = {
  gateway: { id: "default", collectLog: false, skipCache: true },
} as const satisfies AiOptions;
