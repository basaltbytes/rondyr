import type { Submission } from "~/lib/inbox-client";

type Fields = Submission["fields"];
type Field = readonly [name: string, value: string];

// A submission is a free record of fields, so the sender and the body of a
// message are read from the usual field names and from the values.
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const firstNameKeys = /^(?:prenom|prénom|first.?name)$/iu;
const nameKeys = /^(?:nom|name|contact|full.?name|last.?name)$/iu;
const bodyKeys = /^(?:message|msg|demande|commentaire|comment|precisions|précisions|texte|body)$/iu;
const subjectKeys = /^(?:sujet|subject|objet)$/iu;

/** Who wrote: a name, an address, and the one to show in a list. */
export function senderOf(fields: Fields) {
  const entries = Object.entries(fields);
  const first = entries.find(([key]) => firstNameKeys.test(key))?.[1].trim();
  const last = entries.find(([key]) => nameKeys.test(key))?.[1].trim();
  const email = entries.find(([, value]) => emailPattern.test(value.trim()))?.[1].trim() ?? null;
  const name = [first, last].filter((part) => part !== undefined && part !== "").join(" ");
  return { name: name === "" ? null : name, email, label: name === "" ? email : name };
}

/**
 * A message as the reader shows it. Each field appears once: the sender and the
 * subject are in the heading, the body is the text, and `details` are the rest.
 */
export function readMessage(fields: Fields) {
  const entries: readonly Field[] = Object.entries(fields);
  const subject = entries.find(([key]) => subjectKeys.test(key));
  const { body } = splitFields(fields);
  const shown = new Set(
    [
      entries.find(([key]) => firstNameKeys.test(key)),
      entries.find(([key]) => nameKeys.test(key)),
      entries.find(([, value]) => emailPattern.test(value.trim())),
      subject,
      body ?? undefined,
    ].map((entry) => entry?.[0]),
  );
  return {
    sender: senderOf(fields),
    subject: subject?.[1].trim() ?? null,
    body: body?.[1] ?? null,
    details: entries.filter(([key]) => !shown.has(key)),
  };
}

/** The long text of a message, and its other fields in the order received. */
export function splitFields(fields: Fields) {
  const entries: readonly Field[] = Object.entries(fields);
  const body =
    entries.find(([key]) => bodyKeys.test(key)) ?? (entries.length === 1 ? entries[0] : undefined);
  return { body: body ?? null, details: entries.filter((entry) => entry !== body) };
}

export function subjectOf(fields: Fields) {
  return (
    Object.entries(fields)
      .find(([key]) => subjectKeys.test(key))?.[1]
      .trim() ?? null
  );
}

/** One line of the message for a list: its body, or its other fields without the sender. */
export function excerptOf(fields: Fields) {
  const { body, details } = splitFields(fields);
  const text =
    body?.[1] ??
    details
      .filter(
        ([key, value]) =>
          !firstNameKeys.test(key) && !nameKeys.test(key) && !emailPattern.test(value.trim()),
      )
      .map(([, value]) => value)
      .join(" · ");
  return text.replaceAll(/\s+/gu, " ").trim();
}

const timeOfDay = new Intl.DateTimeFormat("fr", { hour: "2-digit", minute: "2-digit" });
const dayOfYear = new Intl.DateTimeFormat("fr", { day: "numeric", month: "short" });
const dayAndTime = new Intl.DateTimeFormat("fr", { dateStyle: "long", timeStyle: "short" });
const day = 86_400_000;

/** When a message arrived, for a list read at `now`: the time today, then "hier", then the date. */
export function listTime(receivedAt: number, now: number) {
  const today = new Date(now).setHours(0, 0, 0, 0);
  if (receivedAt >= today) return timeOfDay.format(receivedAt);
  if (receivedAt >= today - day) return "hier";
  return dayOfYear.format(receivedAt);
}

export function fullTime(receivedAt: number) {
  return dayAndTime.format(receivedAt);
}
