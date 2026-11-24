import { z } from "astro/zod";

import { AutoReply } from "./auto-reply.ts";
import {
  formLayout,
  isPlainEmail,
  type FlatFields,
  type SubmittedData,
  type SubmittedValue,
} from "./fields.ts";

export const turnstileField = "cf-turnstile-response";

export const honeypotField = "_hp";

export const localeField = "_locale";
const reservedFields = new Set([
  turnstileField,
  honeypotField,
  localeField,
  "formId",
  "_return",
  "_block",
  "__proto__",
  "prototype",
  "constructor",
]);
const locale = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/u);
const maxFieldLength = 4000;
const fieldName = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (name) => !reservedFields.has(name) && !/[\p{Cc}\u2028\u2029]/u.test(name),
    "Reserved or invalid form field name",
  );

const NamedField = z.object({
  name: fieldName,
  required: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(maxFieldLength).optional(),
  labels: z
    .record(locale, z.string().min(1).max(500))
    .refine((labels) => Object.keys(labels).length > 0, "Expected at least one locale label"),
});
const Field = z.discriminatedUnion("type", [
  NamedField.extend({
    type: z.enum(["text", "email", "tel", "url", "textarea", "checkbox", "hidden"]),
  }),
  NamedField.extend({
    type: z.literal("select"),
    options: z.array(z.string().trim().min(1).max(maxFieldLength)).min(1),
  }),
]);
type Field = z.infer<typeof Field>;

export const DeclaredForm = z.object({
  slug: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  fields: z
    .array(Field)
    .min(1)
    .max(32)
    .refine(
      (fields) => new Set(fields.map(({ name }) => name)).size === fields.length,
      "Duplicate field name",
    ),
  spamProtection: z.enum(["honeypot", "turnstile"]),
  autoReply: AutoReply.optional(),
});
export type DeclaredForm = z.infer<typeof DeclaredForm>;

export const DeclaredForms = z
  .array(DeclaredForm)
  .refine(
    (forms) => new Set(forms.map(({ slug }) => slug)).size === forms.length,
    "Duplicate form slug",
  );

export const VisitorLocale = locale.transform((value) => value.toLowerCase()).catch("en");

export const VisitorToken = z.string().min(1).max(2048);

export const VisitorIp = z.union([z.ipv4(), z.ipv6()]);

export const Turnstile = z.object({
  token: VisitorToken.nullable(),
  visitorIp: VisitorIp.nullable(),
});
export type Turnstile = z.infer<typeof Turnstile>;

export const FieldError = z.object({ field: z.string(), message: z.string() });
type FieldError = z.infer<typeof FieldError>;

function labelFor(field: Field, language: string): string {
  const labels = new Map(
    Object.entries(field.labels).map(([key, label]) => [key.toLowerCase(), label]),
  );
  const base = language.split("-", 1)[0] ?? language;
  return labels.get(language) ?? labels.get(base) ?? labels.get("en") ?? field.name;
}

export function declaredLayout(form: DeclaredForm, language: string) {
  return formLayout(
    form.slug,
    form.name,
    form.fields.map((entry) => ({
      ...entry,
      label: labelFor(entry, language),
    })),
  );
}

const checked = new Set<SubmittedValue>([true, "true", "on", "1"]);
const unchecked = new Set<SubmittedValue>([false, "false", "off", "0"]);
const Text = z.string().trim();
const WebUrl = z.url({ protocol: /^https?$/u });

function validatedValue(
  field: Field,
  raw: SubmittedValue | undefined,
): { error: string } | { value: string } {
  const text = Text.safeParse(raw).data;
  const value = text ?? raw;
  const invalid = { error: "Enter a valid value." };
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    (field.type === "checkbox" && field.required && unchecked.has(value))
  ) {
    return field.required ? { error: "This field is required." } : { value: "" };
  }
  const limit = field.maxLength ?? maxFieldLength;
  if (text !== undefined && text.length > limit) {
    return { error: `Use at most ${limit} characters.` };
  }
  if (field.type === "checkbox") {
    if (!checked.has(value) && !unchecked.has(value)) return invalid;
    return { value: String(checked.has(value)) };
  }
  if (text === undefined) return invalid;
  switch (field.type) {
    case "email":
      if (!isPlainEmail(text)) return { error: "Enter a valid email address." };
      break;
    case "tel":
      if (!/^[+(\d][\d\s().-]*$/u.test(text)) return { error: "Enter a valid phone number." };
      break;
    case "url":
      if (!WebUrl.safeParse(text).success) {
        return { error: "Enter a valid HTTP or HTTPS URL." };
      }
      break;
    case "select":
      if (!field.options.includes(text)) return { error: "Choose one of the available options." };
      break;
  }
  return { value: text };
}

interface ValidatedFields {
  readonly fields: FlatFields;
  readonly errors: readonly FieldError[];
}

export function validateDeclaredFields(form: DeclaredForm, data: SubmittedData): ValidatedFields {
  const values = new Map<string, string>();
  const errors: FieldError[] = [];
  for (const field of form.fields) {
    const result = validatedValue(
      field,
      Object.hasOwn(data, field.name) ? data[field.name] : undefined,
    );
    if ("error" in result) errors.push({ field: field.name, message: result.error });
    else if (result.value !== "") values.set(field.name, result.value);
  }
  return { fields: Object.fromEntries(values), errors };
}
