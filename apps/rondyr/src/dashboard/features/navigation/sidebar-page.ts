import type { Folder } from "~/lib/messages-search";

/** A page of the organization's settings, or the status of the processing. */
export type SettingsSection =
  | "members"
  | "apiTokens"
  | "retention"
  | "classification"
  | "domains"
  | "quotas"
  | "operations";

/** The page that the sidebar marks as current. */
export type SidebarPage =
  | { readonly at: "messages"; readonly folder: Folder }
  | { readonly at: "form"; readonly publicId: string }
  | { readonly at: "newForm" }
  | { readonly at: "organization" }
  | { readonly at: "settings"; readonly section: SettingsSection };

/**
 * The page of the sidebar that a route declares in its static data. The folder of the
 * messages and the public ID of a form come from the address.
 */
export type SidebarSection =
  | { readonly at: "messages" }
  | { readonly at: "form" }
  | { readonly at: "newForm" }
  | { readonly at: "organization" }
  | { readonly at: "settings"; readonly section: SettingsSection };
