import { z } from "astro/zod";

import { AutoReply } from "./core/auto-reply.ts";
import { FlatFields, FormLayout } from "./core/fields.ts";
import { DeclaredSubmission, newEntry } from "./core/queue.ts";
import { FormsEmails, Store, type StorageHost } from "./store.ts";

/**
 * What the site route sends for a submission that the forms plugin accepted.
 * `formsEmails` says whether the forms plugin held its own emails, and
 * `autoReply` is the auto-reply it held. Both default to what a site route of
 * an earlier version meant: emails sent, no auto-reply.
 */
export const EnqueueInput = z.object({
  submissionId: z.uuid(),
  form: FormLayout,
  fields: FlatFields,
  formsEmails: FormsEmails.default("sent"),
  autoReply: AutoReply.nullable().default(null),
  declared: DeclaredSubmission.optional(),
});
export type EnqueueInput = z.infer<typeof EnqueueInput>;

/**
 * Put a submission in the queue, unless one is already there under its ID.
 * `linked` tells the site route whether the form has a Rondyr form: the forms
 * plugin's held emails are then dropped, since the Rondyr plugin emails the
 * message once Rondyr accepts it, and the held auto-reply waits in the entry
 * until then. Without a Rondyr form, the site route sends the held emails, and
 * the entry keeps no auto-reply: the visitor already got it.
 */
export async function enqueue(
  host: StorageHost,
  input: EnqueueInput,
  now: number,
): Promise<{ readonly linked: boolean }> {
  const { submissionId, form, fields, formsEmails, autoReply, declared } = input;
  const store = new Store(host);
  const link = await store.link(form.slug);
  const linked = link !== null && link.rondyrFormId !== null;
  if (declared === undefined) await store.putLayout(form, formsEmails);
  const heldAutoReply =
    declared !== undefined || (linked && formsEmails === "held") ? autoReply : null;
  const entry = newEntry(form.slug, fields, now, heldAutoReply);
  if (declared !== undefined) entry.declared = declared;
  await store.createQueueEntry(submissionId, entry);
  return { linked };
}
