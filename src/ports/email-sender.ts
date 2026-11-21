import { Context, Effect, Option, Schema } from "effect";

import type { EmailAddress, EmailRecipients } from "../domain/deliveries/email.ts";

/** The stage has no email provider: its credentials or its sender address are not set. */
export class EmailProviderMissing extends Schema.TaggedError<
  EmailProviderMissing,
  { readonly brand: unique symbol }
>()("EmailProviderMissing", {}) {}

/**
 * The provider refused the message, and sending it again would be refused too.
 * The summary contains a status and an error code, never the message content.
 */
export class EmailRejected extends Schema.TaggedError<
  EmailRejected,
  { readonly brand: unique symbol }
>()("EmailRejected", { summary: Schema.String }) {}

/** The provider could not take the message now. Sending it again later can succeed. */
export class EmailUnavailable extends Schema.TaggedError<
  EmailUnavailable,
  { readonly brand: unique symbol }
>()("EmailUnavailable", { summary: Schema.String }) {}

/** One plain text message. Every value placed in a header is already validated. */
export interface EmailMessage {
  readonly from: EmailAddress;
  readonly to: EmailRecipients;
  readonly replyTo: Option.Option<EmailAddress>;
  readonly subject: string;
  readonly text: string;
  /**
   * The same on every attempt of a delivery, so that the provider sends the
   * message once. Another email has a new key of its own.
   */
  readonly idempotencyKey: string;
}

export class EmailSender extends Context.Service<
  EmailSender,
  {
    /** The verified sender address of the stage. */
    readonly sender: Effect.Effect<EmailAddress, EmailProviderMissing>;
    readonly send: (
      message: EmailMessage,
    ) => Effect.Effect<void, EmailRejected | EmailUnavailable | EmailProviderMissing>;
  }
>()("rondyr/ports/email-sender/EmailSender") {}
