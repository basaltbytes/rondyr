import { z } from "astro/zod";

/** A field of an EmDash form, as the forms plugin's public definition describes it. */
export const LayoutField = z.object({
  name: z.string().min(1).max(200),
  label: z.string().max(500),
  type: z.string().max(40),
});
export type LayoutField = z.infer<typeof LayoutField>;

/**
 * The name, slug and fields of an EmDash form, sent with each submission so the
 * notification email can use the labels of the last one.
 */
export const FormLayout = z.object({
  slug: z.string().min(1).max(200),
  name: z.string().max(200),
  fields: z.array(LayoutField).max(200),
});
export type FormLayout = z.infer<typeof FormLayout>;

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

/** A value a visitor sent: a string, a number, a boolean or a list of them. */
export const SubmittedValue = z.union([Scalar, z.array(Scalar), z.null()]);
export type SubmittedValue = z.infer<typeof SubmittedValue>;

export const SubmittedData = z.record(z.string(), SubmittedValue);
export type SubmittedData = z.infer<typeof SubmittedData>;

/** The flat string fields that Rondyr stores, by field name. */
export const FlatFields = z.record(z.string(), z.string());
export type FlatFields = z.infer<typeof FlatFields>;

function flatValue(value: SubmittedValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

/**
 * The fields of a submission as Rondyr takes them: the form's own fields, each
 * value a string. A list is joined with `, `, an empty value is left out, and a
 * file field is never forwarded. Fields the form does not define, such as the
 * honeypot or the Turnstile token, are left out too.
 */
export function flattenFields(layout: FormLayout, data: SubmittedData): FlatFields {
  const fields: FlatFields = {};
  for (const field of layout.fields) {
    if (field.type === "file") continue;
    const text = flatValue(data[field.name]);
    if (text !== "") fields[field.name] = text;
  }
  return fields;
}

const Email = z.email();

/**
 * The submitter's address for `replyTo`: the first valid value of an email
 * field of the form, then of a field named `email`.
 */
export function replyToAddress(layout: FormLayout | null, fields: FlatFields): string | null {
  const names = [
    ...(layout?.fields.filter(({ type }) => type === "email").map(({ name }) => name) ?? []),
    "email",
  ];
  for (const name of names) {
    const value = fields[name];
    if (value !== undefined && Email.safeParse(value).success) return value;
  }
  return null;
}

export interface Notification {
  readonly subject: string;
  readonly text: string;
}

/**
 * The notification email of an accepted submission, in the format of the forms
 * plugin's `formatSubmissionText`: one `Label: value` line per filled field, in
 * the form's order, hidden fields left out, then the reception time. A field the
 * layout does not know keeps its name as its label.
 */
export function formatNotification(
  layout: FormLayout | null,
  formName: string,
  fields: FlatFields,
  receivedAt: string,
): Notification {
  const name = layout?.name ?? formName;
  const lines = [`New submission for "${name}"`, ""];
  const known = new Set<string>();
  for (const field of layout?.fields ?? []) {
    known.add(field.name);
    const value = fields[field.name];
    if (field.type === "hidden" || value === undefined || value === "") continue;
    lines.push(`${field.label}: ${value}`);
  }
  for (const [field, value] of Object.entries(fields)) {
    if (!known.has(field) && value !== "") lines.push(`${field}: ${value}`);
  }
  lines.push("", `Submitted at: ${receivedAt}`);
  return { subject: `New submission: ${name}`, text: lines.join("\n") };
}
