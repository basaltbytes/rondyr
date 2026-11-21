/**
 * The first letters of the first two words of a name, in capitals, such as "AT"
 * for "Atelier Terre & Feu". A name without a letter or a digit gives "?".
 */
export function initialsOf(name: string) {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
  const letters = `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`;
  return letters === "" ? "?" : letters.toUpperCase();
}
