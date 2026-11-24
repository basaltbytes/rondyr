import { z } from "astro/zod";

import { isPlainEmail, submitterAddress, type FlatFields, type FormLayout } from "./fields.ts";

/**
 * The auto-reply that the forms plugin wrote for a submission of a linked
 * form and that the site held: its subject and body, exactly as the forms
 * plugin built them. It goes to the visitor once Rondyr accepts the message.
 * The visitor's address is not kept: it comes from the accepted message.
 */
export const AutoReply = z.object({
  subject: z.string().min(1).max(1_000),
  text: z.string().min(1).max(50_000),
  html: z.string().max(200_000).optional(),
});
export type AutoReply = z.infer<typeof AutoReply>;

export interface AutoReplyMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/**
 * The auto-reply to send for an accepted message, or null when the message
 * has no plain address in an email field of its form. The address is the one
 * the forms plugin answers: the first filled email field, a required one
 * before an optional one.
 */
export function autoReplyMessage(
  autoReply: AutoReply,
  layout: FormLayout | null,
  fields: FlatFields,
): AutoReplyMessage | null {
  const to = submitterAddress(layout, fields);
  if (to === null || !isPlainEmail(to)) return null;
  const { subject, text, html } = autoReply;
  return html === undefined ? { to, subject, text } : { to, subject, text, html };
}
