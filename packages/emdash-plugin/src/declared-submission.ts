import { z } from "astro/zod";

import {
  DeclaredForm,
  declaredLayout,
  FieldError,
  honeypotField,
  localeField,
  turnstileField,
  validateDeclaredFields,
  VisitorIp,
  VisitorLocale,
  VisitorToken,
} from "./core/declared-forms.ts";
import { SubmittedData } from "./core/fields.ts";
import { submissionBody } from "./core/rondyr-client.ts";
import type { EnqueueInput } from "./enqueue.ts";

export const DeclaredPost = z.object({
  formId: z.string().min(1).max(200),
  data: SubmittedData,
  locale: z.string().optional(),
  fileFields: z.array(z.string()),
});

export const RenderableForm = DeclaredForm.omit({ autoReply: true }).extend({
  turnstileSiteKey: z.string().nullable(),
});
export type RenderableForm = z.infer<typeof RenderableForm>;

export const DeclaredAnswer = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), message: z.string() }),
  z.object({
    success: z.literal(false),
    code: z.string(),
    message: z.string(),
    errors: z.array(FieldError).optional(),
  }),
]);
type DeclaredAnswer = z.infer<typeof DeclaredAnswer>;

const accepted = { success: true, message: "Submitted successfully." } satisfies DeclaredAnswer;
const invalid = (code: string, message: string, errors?: z.infer<typeof FieldError>[]) =>
  ({ success: false, code, message, errors }) satisfies DeclaredAnswer;

interface PreparedSubmission {
  readonly answer: DeclaredAnswer;
  readonly entry?: EnqueueInput;
}

/** Validate a declared post and prepare the entry accepted by the queue. */
export function prepareDeclaredSubmission(
  form: DeclaredForm | undefined,
  post: z.infer<typeof DeclaredPost>,
  visitorIp: string | null,
): PreparedSubmission {
  if (form === undefined) return { answer: invalid("NOT_FOUND", "Form not found") };
  if (post.fileFields.length > 0) {
    const message = "File uploads are not supported.";
    return {
      answer: invalid(
        "INVALID_REQUEST",
        message,
        post.fileFields.map((field) => ({ field, message })),
      ),
    };
  }
  if (post.data[honeypotField]) return { answer: accepted };
  const { fields, errors } = validateDeclaredFields(form, post.data);
  if (errors.length > 0) {
    return { answer: invalid("VALIDATION_ERROR", "Check the form fields.", [...errors]) };
  }
  if (Object.keys(fields).length === 0) {
    return { answer: invalid("VALIDATION_ERROR", "Fill in at least one field.") };
  }

  const locale = VisitorLocale.parse(post.locale ?? post.data[localeField]);
  const declared: NonNullable<EnqueueInput["declared"]> = { locale };
  if (form.spamProtection === "turnstile") {
    declared.turnstile = {
      token: VisitorToken.safeParse(post.data[turnstileField]).data ?? null,
      visitorIp: VisitorIp.safeParse(visitorIp).data ?? null,
    };
  }
  // Apply the Worker's intake limit before acknowledging a post that would always be refused.
  if (
    new TextEncoder().encode(submissionBody(fields, declared.turnstile?.token)).length >
    16 * 1024
  ) {
    return { answer: invalid("VALIDATION_ERROR", "The submission is too long.") };
  }

  return {
    answer: accepted,
    entry: {
      submissionId: crypto.randomUUID(),
      form: declaredLayout(form, locale),
      fields,
      formsEmails: "held",
      autoReply: form.autoReply ?? null,
      declared,
    },
  };
}

/**
 * Validate a declared post and queue it before the visitor gets the answer.
 * The queue write is idempotent on the submission ID, so a failed write is
 * made once more, as the site route does in forms plugin mode. A second
 * failure is thrown: the visitor is told the message was not sent.
 */
export async function receiveDeclaredPost(
  form: DeclaredForm | undefined,
  post: z.infer<typeof DeclaredPost>,
  visitorIp: string | null,
  queue: (entry: EnqueueInput) => Promise<void>,
): Promise<DeclaredAnswer> {
  const { answer, entry } = prepareDeclaredSubmission(form, post, visitorIp);
  if (entry !== undefined) await queue(entry).catch(() => queue(entry));
  return answer;
}
