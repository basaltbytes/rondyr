import { cn } from "cn";
import { ChevronLeft, Plus } from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { SidebarTrigger } from "~/components/ui/sidebar";
import type { Inbox } from "~/lib/inbox-client";

import { AllowedOrigins } from "./allowed-origins.tsx";
import { EmailTargets } from "./email-targets.tsx";
import { FormSettings, NewForm } from "./form-management.tsx";
import { InboxSetup } from "./inbox-setup.tsx";
import type { Section } from "./inbox-sidebar.tsx";
import { formStatusLabels, sectionLabels } from "./strings.ts";
import { WebhookTargets } from "./webhook-targets.tsx";

type Form = Inbox["forms"][number];

/** What the third pane shows: a form, the new form, or nothing picked yet. */
type Picked = Form["publicId"] | "new" | null;

const newForm = "new";

interface FormListProps {
  readonly section: Exclude<Section, "operations">;
  readonly forms: readonly Form[];
  /** The form shown in the next pane. */
  readonly shown: Form | undefined;
  readonly adding: boolean;
  /** Hidden on a narrow screen while a form is open. */
  readonly collapsed: boolean;
  readonly onPick: (picked: Picked) => void;
}

function FormList({ section, forms, shown, adding, collapsed, onPick }: FormListProps) {
  return (
    <section
      aria-label="Formulaires de l’organisation"
      className={cn("flex min-h-0 flex-col bg-card lg:hairline-r", collapsed && "max-lg:hidden")}
    >
      <header className="flex h-14 shrink-0 items-center gap-1 hairline-b pr-2 pl-1">
        <SidebarTrigger />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
          {sectionLabels[section]}
        </h1>
        {section === "forms" && (
          <Button variant="ghost" size="sm" onClick={() => onPick(newForm)}>
            <Plus aria-hidden="true" className="size-4" />
            Nouveau
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 lg:overflow-y-auto">
        {forms.length === 0 ? (
          <div className="grid justify-items-start gap-2 px-4 py-10">
            <h2 className="text-base font-semibold text-balance">Aucun formulaire</h2>
            <p className="max-w-prose text-sm text-pretty text-muted-foreground">
              Un formulaire donne une adresse d’envoi à mettre sur votre site.
            </p>
          </div>
        ) : (
          <ul>
            {forms.map((form) => {
              const active = !adding && form.publicId === shown?.publicId;
              return (
                <li key={form.publicId} className="hairline-b">
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => onPick(form.publicId)}
                    className={cn(
                      "grid w-full grid-cols-1 gap-1 px-4 py-3 text-start transition-colors duration-150 ease-out",
                      active ? "bg-accent" : "hover:bg-muted",
                    )}
                  >
                    <span className="line-clamp-2 text-sm font-medium wrap-anywhere">
                      {form.name}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {form.status === "suspended" && (
                        <Badge variant="neutral">{formStatusLabels.suspended}</Badge>
                      )}
                      <span className="truncate font-mono">{form.publicId}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

interface InboxSettingsProps {
  /** A settings page. The status of the processing is another feature's page. */
  readonly section: Exclude<Section, "operations">;
  readonly inbox: Inbox;
  /** Reload the organizations after a change to their forms. */
  readonly onFormsChanged: () => Promise<void>;
  readonly onOrganizationCreated: () => void;
}

/** The settings of an organization: its forms on the left, the picked form's settings on the right. */
export function InboxSettings({
  section,
  inbox,
  onFormsChanged,
  onOrganizationCreated,
}: InboxSettingsProps) {
  const [picked, setPicked] = useState<Picked>(null);

  if (section === "organization") {
    return (
      <main className="min-w-0 lg:col-span-2 lg:overflow-y-auto">
        <header className="flex h-14 items-center px-1">
          <SidebarTrigger />
        </header>
        <div className="mx-auto max-w-xl px-5 pb-8">
          <InboxSetup onCreated={onOrganizationCreated} />
        </div>
      </main>
    );
  }

  // A wide screen shows the first form until one is picked. A narrow one shows the list.
  const adding = section === "forms" && (picked === newForm || inbox.forms.length === 0);
  const shown = inbox.forms.find((form) => form.publicId === picked) ?? inbox.forms[0];
  const open = picked !== null;

  return (
    <>
      <FormList
        section={section}
        forms={inbox.forms}
        shown={shown}
        adding={adding}
        collapsed={open}
        onPick={setPicked}
      />
      <main className={cn("min-w-0 lg:overflow-y-auto", !open && "max-lg:hidden")}>
        <div className="mx-auto grid max-w-2xl gap-4 px-5 py-5">
          <header className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Retour aux formulaires"
              className="-ml-2 lg:hidden"
              onClick={() => setPicked(null)}
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
            </Button>
            <h2 className="min-w-0 text-lg/snug font-semibold wrap-anywhere">
              {adding ? "Nouveau formulaire" : (shown?.name ?? sectionLabels[section])}
            </h2>
          </header>
          {adding && (
            <NewForm inboxId={inbox.id} onChanged={onFormsChanged} onCreated={setPicked} />
          )}
          {!adding && shown === undefined && (
            <p className="text-sm text-pretty text-muted-foreground">
              Cette organisation n’a pas encore de formulaire. Créez-en un dans Formulaires.
            </p>
          )}
          {!adding && shown !== undefined && section === "forms" && (
            <FormSettings
              key={shown.publicId}
              inboxId={inbox.id}
              form={shown}
              onChanged={onFormsChanged}
            />
          )}
          {shown !== undefined && section === "destinations" && (
            <>
              <WebhookTargets key={`webhooks-${shown.publicId}`} inboxId={inbox.id} form={shown} />
              <EmailTargets key={`emails-${shown.publicId}`} inboxId={inbox.id} form={shown} />
            </>
          )}
          {shown !== undefined && section === "origins" && (
            <AllowedOrigins key={shown.publicId} inboxId={inbox.id} form={shown} />
          )}
        </div>
      </main>
    </>
  );
}
