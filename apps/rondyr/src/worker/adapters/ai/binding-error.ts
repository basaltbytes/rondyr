import { Schema } from "effect";

import { ClassificationFailed } from "../../../domain/submissions/classifier.external.ts";

const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }));
const codePrefix = /^(?:(?:AiGatewayError|InferenceUpstreamError):\s*)?(\d{4}):/u;

const permanentCodes = new Set([
  // https://developers.cloudflare.com/workers-ai/platform/errors/
  "3003",
  "3006",
  "3023",
  "3036",
  "3039",
  "3041",
  "3042",
  "5004",
  "5005",
  "5007",
  "5016",
  "5018",
  "5019",
  "5028",
  "5035",
  // https://developers.cloudflare.com/ai-gateway/reference/troubleshooting/
  "2009",
  "2021",
  "2036",
  "2042",
  "2044",
  "2049",
  "2052",
  "7000",
  "7003",
]);

export function mapBindingError(cause: unknown) {
  // The binding can expose the upstream code at the start of Error.message.
  // Keep unknown failures retryable and never retain the upstream message.
  const code = hasMessage(cause) ? codePrefix.exec(cause.message)?.[1] : undefined;
  return ClassificationFailed.make({
    retryable: code === undefined || !permanentCodes.has(code),
    kind: "upstream-error",
    ...(code !== undefined && { upstreamCode: code }),
  });
}
