const encoder = new TextEncoder();

/** A delivery's fields, as Rondyr sends them in version 1 of the webhook payload. */
export interface AcceptedDelivery {
  readonly deliveryId: string;
  readonly submissionId: string;
  readonly receivedAt: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly formId: string;
}

/** The body of a `submission.accepted` delivery. */
export function acceptedPayload(delivery: AcceptedDelivery): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      version: 1,
      type: "submission.accepted",
      deliveryId: delivery.deliveryId,
      submission: {
        id: delivery.submissionId,
        receivedAt: delivery.receivedAt,
        fields: delivery.fields,
      },
      form: { id: delivery.formId, name: "Rondyr form" },
    }),
  );
}

/** The headers Rondyr signs a delivery with, at `at` (Unix milliseconds). */
export async function signedHeaders(body: Uint8Array, secret: string, at: number) {
  const timestamp = String(Math.floor(at / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new Uint8Array([...encoder.encode(`${timestamp}.`), ...body]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Headers({ "rondyr-timestamp": timestamp, "rondyr-signature": `v1=${hex}` });
}
