import type { AutoReply } from "./core/auto-reply.ts";

/**
 * A submission that the site route hands to the forms plugin's `submit` in
 * this Worker, on its way to Rondyr. The forms plugin of this package holds
 * the emails that the forms plugin would send at once, and reports here what
 * it held; the site route then settles them once it knows whether the form is
 * linked to a Rondyr form.
 *
 * A submission posted straight to the forms plugin's own route has no
 * handoff: its emails go out as the forms plugin sends them.
 */
export interface Handoff {
  /** Whether the forms plugin of this package took the submission and holds its emails. */
  held: boolean;
  /** The auto-reply that the forms plugin wrote for the visitor and that is held, if any. */
  autoReply: AutoReply | null;
  /**
   * Send the held emails (`handled` false), or drop them because Rondyr has
   * the submission and its linked form emails accepted messages (`handled`
   * true). Only the first call counts.
   */
  settle: (handled: boolean) => Promise<void>;
}

/** The header that names the handoff, on the in-process request to the forms plugin's `submit`. */
export const handoffHeader = "x-rondyr-handoff";

declare global {
  /**
   * The handoffs in progress in this Worker isolate, by random ID. They live
   * on `globalThis`, not in this module, so that the site route and the forms
   * plugin see the same map when a build bundles them into separate chunks.
   */
  var rondyrEmdashPluginHandoffs: Map<string, Handoff> | undefined;
}

function handoffs(): Map<string, Handoff> {
  globalThis.rondyrEmdashPluginHandoffs ??= new Map();
  return globalThis.rondyrEmdashPluginHandoffs;
}

/** An open handoff: the ID for the header, the handoff, and how to close it. */
export interface OpenHandoff {
  readonly id: string;
  readonly handoff: Handoff;
  close(): void;
}

/**
 * Open a handoff for one call to the forms plugin's `submit`. Its ID is
 * random and exists only while the site route waits for that call, so a
 * visitor who sends the header with a guessed value gets no handoff.
 */
export function openHandoff(): OpenHandoff {
  const id = crypto.randomUUID();
  const handoff: Handoff = { held: false, autoReply: null, settle: async () => {} };
  handoffs().set(id, handoff);
  return { id, handoff, close: () => handoffs().delete(id) };
}

/** The open handoff named by a request's header, once: a second claim gets nothing. */
export function claimHandoff(header: string | null): Handoff | undefined {
  if (header === null) return undefined;
  const handoff = handoffs().get(header);
  if (handoff === undefined || handoff.held) return undefined;
  handoff.held = true;
  return handoff;
}
