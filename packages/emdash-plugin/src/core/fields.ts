import { z } from "astro/zod";

/**
 * A field of an EmDash form, as the forms plugin's public definition describes
 * it. `required` is set only on a required field; layouts stored before it
 * existed don't have it.
 */
export const LayoutField = z.object({
  name: z.string().min(1).max(200),
  label: z.string().max(500),
  type: z.string().max(40),
  required: z.literal(true).optional(),
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

/**
 * The layout of a form as the forms plugin's definition gives it, cut to the
 * limits of `FormLayout`, so that an unusual form never stops a submission from
 * being queued. A field name that is empty or too long is left out.
 */
export function formLayout(
  slug: string,
  name: string,
  fields: readonly {
    readonly name: string;
    readonly label: string;
    readonly type: string;
    readonly required?: boolean | undefined;
  }[],
): FormLayout {
  return {
    slug: slug.slice(0, 200),
    name: name.slice(0, 200),
    fields: fields
      .filter((field) => field.name.length > 0 && field.name.length <= 200)
      .slice(0, 200)
      .map((field) => {
        const layoutField: LayoutField = {
          name: field.name,
          label: field.label.slice(0, 500),
          type: field.type.slice(0, 40),
        };
        if (field.required === true) layoutField.required = true;
        return layoutField;
      }),
  };
}

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
  if (Array.isArray(value)) return value.map(String).join(", ").trim();
  return String(value).trim();
}

/**
 * The fields of a submission as Rondyr takes them: the form's own fields, each
 * value a string. A value is trimmed, as the forms plugin trims what it stores,
 * a list is joined with `, `, an empty value is left out, and a file field is
 * never forwarded. Fields the form does not define, such as the honeypot or the
 * Turnstile token, are left out too.
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
 * The submitter's address as the forms plugin finds it: the value of the first
 * filled email field of the form, a required one before an optional one. Null
 * for a form without a filled email field, or an unknown layout.
 */
export function submitterAddress(layout: FormLayout | null, fields: FlatFields): string | null {
  const emailFields = layout?.fields.filter(({ type }) => type === "email") ?? [];
  const value = [
    ...emailFields.filter(({ required }) => required === true),
    ...emailFields.filter(({ required }) => required !== true),
  ]
    .map(({ name }) => fields[name])
    .find((candidate) => candidate !== undefined && candidate !== "");
  return value ?? null;
}

/**
 * The submitter's address for `replyTo`, chosen as the forms plugin chooses it:
 * the first filled email field of the form, a required one before an optional
 * one, and only when it is a plain address. A form without a filled email
 * field, or an unknown layout, falls back to a field named `email`.
 */
export function replyToAddress(layout: FormLayout | null, fields: FlatFields): string | null {
  const email = fields["email"];
  const value =
    submitterAddress(layout, fields) ?? (email !== undefined && email !== "" ? email : null);
  return value !== null && Email.safeParse(value).success ? value : null;
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
