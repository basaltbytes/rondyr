import { Predicate } from "effect";

/**
 * Reads the search params of an address as texts. The router's default would read a
 * number or JSON out of a text, so a search for "123" would no longer be a text.
 */
export function parseSearch(search: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(search));
}

/** Writes search params as texts, without quotes, and leaves out those without a value. */
export function stringifySearch(search: Readonly<Record<string, string | undefined>>) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(search)) {
    if (Predicate.isString(value)) params.set(name, value);
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}
