import { useActionState } from "react";

import { FormProblem, TextAreaField, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { createInbox } from "~/lib/inbox-client";

interface InboxSetupProps {
  readonly onCreated: () => void;
}

/** Creates an organization and its first form. */
export function InboxSetup({ onCreated }: InboxSetupProps) {
  const [error, action, pending] = useActionState(async (_: string | null, form: FormData) => {
    try {
      await createInbox(form);
      onCreated();
      return null;
    } catch {
      return "La boîte n’a pas pu être créée. Vérifiez les champs et réessayez.";
    }
  }, null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Nouvelle organisation</CardTitle>
        <CardDescription>
          Une organisation a sa boîte de réception, ses formulaires et ses destinations.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4">
          <TextField label="Organisation" name="organizationName" required maxLength={100} />
          <TextField
            label="Nom du premier formulaire"
            name="formName"
            required
            maxLength={100}
            placeholder="Contact"
          />
          <TextAreaField
            label="Activité de l’organisation"
            name="businessContext"
            maxLength={2000}
            hint="Facultatif. Le filtre s’en sert pour juger si un message concerne votre activité."
          />
          <FormProblem>{error}</FormProblem>
          <Button type="submit" variant="default" className="justify-self-start" disabled={pending}>
            {pending ? "Création en cours…" : "Créer l’organisation"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
