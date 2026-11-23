import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";

import { ConnectorType } from "@rondyr/deliveries/connectors/catalog";
import {
  ConnectorTarget,
  CreateConnectorTarget,
} from "@rondyr/deliveries/connectors/connector-target";
import { EmailLanguage, EmailTarget } from "@rondyr/deliveries/email";
import { TargetTestResult } from "@rondyr/deliveries/history";
import { DestinationTarget, TargetRequestError } from "@rondyr/deliveries/targets";
import { IssuedWebhookSecret, WebhookTarget } from "@rondyr/deliveries/webhook";

import { keepReadTime } from "./cache.ts";
import { organizationPath, refusalOf, request, requestJson } from "./request.ts";

/** A destination of a form: a webhook, an email destination or one of a connector. */
export type DestinationTarget = typeof DestinationTarget.Type;
export type WebhookTarget = typeof WebhookTarget.Type;
export type EmailTarget = typeof EmailTarget.Type;
/** A destination that a connector sends to, such as a Discord channel. */
export type ConnectorTarget = typeof ConnectorTarget.Type;
/** The type, the name and every setting of a destination of a connector. */
export type CreateConnectorTarget = typeof CreateConnectorTarget.Type;
/** A language in which Rondyr writes the emails of a destination. */
export type { EmailLanguage };
export type IssuedWebhookSecret = typeof IssuedWebhookSecret.Type;
export type TargetRequestError = typeof TargetRequestError.Type;
export type TargetTestResult = typeof TargetTestResult.Type;

export const isConnectorType = Schema.is(ConnectorType);

export const destinationLanguages = EmailLanguage.literals;

export const isDestinationLanguage = Schema.is(EmailLanguage);

const Destinations = Schema.Array(DestinationTarget);
const refusal = TargetRequestError;

/** The reason that the destinations API gave for a refusal, if any. */
export function destinationRefusalOf(cause: unknown) {
  return refusalOf(cause, TargetRequestError);
}

const formDestinations = (organizationId: string, publicId: string) =>
  organizationPath(organizationId, "forms", publicId, "targets");
const destination = (
  organizationId: string,
  targetId: string,
  ...segments: ReadonlyArray<string>
) => organizationPath(organizationId, "targets", targetId, ...segments);

/** The destinations of a form: webhooks, emails and the destinations of connectors. */
export function destinationsQuery(organizationId: string, publicId: string) {
  return queryOptions({
    queryKey: [organizationId, "forms", publicId, "destinations"] as const,
    queryFn: ({ signal }) =>
      requestJson(formDestinations(organizationId, publicId), Destinations, { signal }),
  });
}

/** A destination as the API answers with it, and the signing secret it issued, if any. */
export interface SavedDestination {
  readonly target: DestinationTarget;
  /** The secret of a webhook, shown once: when it is created and when it is rotated. */
  readonly issued: IssuedWebhookSecret | null;
}

/** A new destination of a form. Without a language, an email destination gets the default one. */
export type NewDestination =
  | { readonly type: "webhook"; readonly url: string }
  | {
      readonly type: "email";
      readonly recipients: ReadonlyArray<string>;
      readonly language: EmailLanguage | undefined;
    }
  | { readonly type: "connector"; readonly draft: CreateConnectorTarget };

async function addDestination(
  organizationId: string,
  publicId: string,
  added: NewDestination,
): Promise<SavedDestination> {
  const path = formDestinations(organizationId, publicId);
  switch (added.type) {
    case "webhook": {
      const issued = await requestJson(path, IssuedWebhookSecret, {
        method: "POST",
        json: { type: "webhook", url: added.url },
        refusal,
      });
      return { target: issued.target, issued };
    }
    case "email": {
      const json =
        added.language === undefined
          ? { type: "email", recipients: added.recipients }
          : { type: "email", recipients: added.recipients, language: added.language };
      const target = await requestJson(path, EmailTarget, { method: "POST", json, refusal });
      return { target, issued: null };
    }
    case "connector": {
      const target = await requestJson(path, ConnectorTarget, {
        method: "POST",
        json: added.draft,
        refusal,
      });
      return { target, issued: null };
    }
  }
}

/** A change of a destination. Without a language, an email destination keeps its own. */
export type DestinationChange =
  | {
      readonly change: "recipients";
      readonly recipients: ReadonlyArray<string>;
      readonly language: EmailLanguage | undefined;
    }
  | { readonly change: "settings"; readonly draft: CreateConnectorTarget }
  | { readonly change: "active"; readonly active: boolean }
  | { readonly change: "secret" };

async function changeDestination(
  organizationId: string,
  targetId: string,
  change: DestinationChange,
): Promise<SavedDestination> {
  switch (change.change) {
    case "recipients": {
      const json =
        change.language === undefined
          ? { recipients: change.recipients }
          : { recipients: change.recipients, language: change.language };
      const target = await requestJson(
        destination(organizationId, targetId, "recipients"),
        EmailTarget,
        { method: "PUT", json, refusal },
      );
      return { target, issued: null };
    }
    case "settings": {
      const target = await requestJson(
        destination(organizationId, targetId, "settings"),
        ConnectorTarget,
        { method: "PUT", json: change.draft, refusal },
      );
      return { target, issued: null };
    }
    case "active": {
      const target = await requestJson(
        destination(organizationId, targetId, change.active ? "activate" : "deactivate"),
        DestinationTarget,
        { method: "POST", refusal },
      );
      return { target, issued: null };
    }
    case "secret": {
      const issued = await requestJson(
        destination(organizationId, targetId, "rotate-secret"),
        IssuedWebhookSecret,
        { method: "POST", refusal },
      );
      return { target: issued.target, issued };
    }
  }
}

function cache(client: QueryClient, organizationId: string, publicId: string) {
  return {
    add: (target: DestinationTarget) =>
      client.setQueryData(
        destinationsQuery(organizationId, publicId).queryKey,
        (targets) => (targets === undefined ? undefined : [...targets, target]),
        keepReadTime(client, destinationsQuery(organizationId, publicId).queryKey),
      ),
    replace: (target: DestinationTarget) =>
      client.setQueryData(
        destinationsQuery(organizationId, publicId).queryKey,
        (targets) => targets?.map((item) => (item.id === target.id ? target : item)),
        keepReadTime(client, destinationsQuery(organizationId, publicId).queryKey),
      ),
  };
}

/** Adds a destination to a form, then to its cached destinations. */
export function addDestinationMutation(organizationId: string, publicId: string) {
  return mutationOptions({
    mutationFn: (added: NewDestination) => addDestination(organizationId, publicId, added),
    onSuccess: ({ target }, _added, _context, { client }) =>
      cache(client, organizationId, publicId).add(target),
  });
}

/** Changes a destination of a form, then its cached copy. */
export function changeDestinationMutation(
  organizationId: string,
  publicId: string,
  targetId: DestinationTarget["id"],
) {
  return mutationOptions({
    mutationFn: (change: DestinationChange) => changeDestination(organizationId, targetId, change),
    onSuccess: ({ target }, _change, _context, { client }) =>
      cache(client, organizationId, publicId).replace(target),
  });
}

/**
 * Email a pending recipient of an email destination a new confirmation link. The API
 * answers 409 for a confirmed address and 429 once the address got its confirmation
 * emails of the day.
 */
export async function resendConfirmation(
  organizationId: string,
  targetId: DestinationTarget["id"],
  address: string,
) {
  await request(destination(organizationId, targetId, "confirmations"), {
    method: "POST",
    json: { address },
    refusal,
  });
}

/** Confirm a recipient with the secret of its link. The secret goes in the body, never in a URL. */
export async function confirmRecipient(token: string) {
  await request("/api/recipient-confirmations", { method: "POST", json: { token }, refusal });
}

/** Send a test message to a destination and wait for the answer of its recipient. */
export function testDestination(organizationId: string, targetId: DestinationTarget["id"]) {
  return requestJson(destination(organizationId, targetId, "test"), TargetTestResult, {
    method: "POST",
    refusal,
  });
}
