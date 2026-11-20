import { Option, Schema } from "effect";
import { useActionState, useState } from "react";

import { FormProblem, TextAreaField, TextField } from "~/components/text-field";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

import {
  clearHoneypotField,
  clearSuccessUrl,
  createForm,
  FormRequestFailed,
  setFormStatus,
  setHoneypotField,
  setSuccessUrl,
  updateForm,
} from "~/lib/forms-client";
import type { Form } from "~/lib/forms-client";
import type { Inbox } from "~/lib/inbox-client";

import { formStatusLabels, successUrlRefusals } from "./strings.ts";

const isFailed = Schema.is(FormRequestFailed);

/** Run a request and return the message to show if it fails, or null. */
async function attempt(request: () => Promise<void>, fallback: string) {
  try {
    await request();
    return null;
  } catch (error) {
    if (!isFailed(error)) return fallback;
    return Option.match(error.problem, {
      onNone: () => fallback,
      onSome: (problem) => successUrlRefusals[problem.reason],
    });
  }
}

function text(data: FormData, name: string) {
  return data.get(name)?.toString() ?? "";
}

interface FormSettingsProps {
  readonly inboxId: Inbox["id"];
  readonly form: Form;
  readonly onChanged: () => Promise<void>;
}

/** One form: public URL, name, business context, redirect, honeypot field and status. */
export function FormSettings({ inboxId, form, onChanged }: FormSettingsProps) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const publicUrl = `${window.location.origin}/f/${encodeURIComponent(form.publicId)}`;

  const [editProblem, edit, saving] = useActionState(
    (_: string | null, data: FormData) =>
      attempt(async () => {
        await updateForm(inboxId, form.publicId, text(data, "name"), text(data, "businessContext"));
        await onChanged();
        setEditing(false);
      }, "Le formulaire n’a pas pu être modifié. Vérifiez les champs et réessayez."),
    null,
  );

  const [statusProblem, changeStatus, changing] = useActionState(
    (_: string | null, data: FormData) => {
      const action = data.get("action");
      if (action !== "suspend" && action !== "reactivate") return null;
      return attempt(async () => {
        await setFormStatus(inboxId, form.publicId, action);
        await onChanged();
        setConfirming(false);
      }, "Le statut n’a pas pu être modifié. Réessayez.");
    },
    null,
  );

  const [redirectProblem, changeRedirect, redirecting] = useActionState(
    (_: string | null, data: FormData) => {
      const clear = data.get("action") === "clear";
      return attempt(async () => {
        if (clear) await clearSuccessUrl(inboxId, form.publicId);
        else await setSuccessUrl(inboxId, form.publicId, text(data, "url"));
        await onChanged();
      }, "La redirection n’a pas pu être enregistrée. Réessayez.");
    },
    null,
  );

  const [honeypotProblem, changeHoneypot, trapping] = useActionState(
    (_: string | null, data: FormData) => {
      const clear = data.get("action") === "clear";
      return attempt(async () => {
        if (clear) await clearHoneypotField(inboxId, form.publicId);
        else await setHoneypotField(inboxId, form.publicId, text(data, "field"));
        await onChanged();
      }, "Le champ piège n’a pas pu être enregistré. Vérifiez le nom et réessayez.");
    },
    null,
  );

  return (
    <div className="grid gap-4" aria-label={`Réglages du formulaire ${form.name}`}>
      <Card>
        <CardHeader>
          <CardTitle>Adresse d’envoi</CardTitle>
          <CardDescription>
            {form.status === "suspended"
              ? "Ce formulaire refuse les nouveaux messages. Les messages reçus restent dans la boîte de réception."
              : "L’adresse à mettre dans l’attribut action de votre formulaire, ou à appeler en POST."}
          </CardDescription>
          <CardAction>
            <Badge variant={form.status === "active" ? "success" : "neutral"}>
              {formStatusLabels[form.status]}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 basis-64 rounded-md bg-muted px-3 py-2 font-mono text-sm wrap-anywhere">
              {publicUrl}
            </code>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(publicUrl).then(() => setCopied(true));
              }}
            >
              {copied ? "Adresse copiée" : "Copier l’adresse"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Nom et activité</CardTitle>
          <CardDescription>
            {form.businessContext === null
              ? "Aucune activité décrite : la pertinence des messages n’est pas évaluée."
              : form.businessContext}
          </CardDescription>
          {!editing && (
            <CardAction>
              <Button size="sm" onClick={() => setEditing(true)}>
                Modifier
              </Button>
            </CardAction>
          )}
        </CardHeader>
        {editing && (
          <CardContent>
            <form action={edit} className="grid gap-4">
              <TextField
                label="Nom du formulaire"
                name="name"
                required
                maxLength={100}
                defaultValue={form.name}
              />
              <TextAreaField
                label="Activité de l’organisation"
                name="businessContext"
                maxLength={2000}
                defaultValue={form.businessContext ?? ""}
                hint="Facultatif. Le filtre s’en sert pour juger si un message concerne votre activité."
              />
              <FormProblem>{editProblem}</FormProblem>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="default" disabled={saving}>
                  Enregistrer
                </Button>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Annuler
                </Button>
              </div>
            </form>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Redirection après envoi</CardTitle>
          <CardDescription>
            Après un envoi depuis un formulaire HTML, le visiteur voit{" "}
            {form.successUrl === null ? (
              "la page de confirmation de Rondyr."
            ) : (
              <>
                <code className="font-mono wrap-anywhere">{form.successUrl}</code>.
              </>
            )}{" "}
            L’origine de l’adresse doit figurer dans les origines autorisées du formulaire.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={changeRedirect} className="grid gap-3">
            <div className="flex flex-wrap items-end gap-2">
              <TextField
                label="Adresse de redirection"
                className="min-w-0 flex-1 basis-64"
                type="url"
                name="url"
                required
                maxLength={2048}
                placeholder="https://www.example.com/merci"
              />
              <Button type="submit" name="action" value="set" disabled={redirecting}>
                Enregistrer la redirection
              </Button>
              {form.successUrl !== null && (
                <Button
                  type="submit"
                  variant="ghost"
                  name="action"
                  value="clear"
                  formNoValidate
                  disabled={redirecting}
                >
                  Retirer la redirection
                </Button>
              )}
            </div>
            <FormProblem>{redirectProblem}</FormProblem>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Champ piège</CardTitle>
          <CardDescription>
            {form.honeypotField === null ? (
              "Aucun champ piège. "
            ) : (
              <>
                Champ actuel : <code className="font-mono wrap-anywhere">{form.honeypotField}</code>
                .{" "}
              </>
            )}
            Ajoutez à votre formulaire un champ texte de ce nom, masqué par CSS, avec{" "}
            <code className="font-mono">tabindex="-1"</code> et{" "}
            <code className="font-mono">autocomplete="off"</code> : les visiteurs le laissent vide,
            et un message qui le remplit est mis à vérifier sans être analysé.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={changeHoneypot} className="grid gap-3">
            <div className="flex flex-wrap items-end gap-2">
              <TextField
                label="Nom du champ piège"
                className="min-w-0 flex-1 basis-64"
                name="field"
                required
                maxLength={100}
                placeholder="_hp"
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="submit" name="action" value="set" disabled={trapping}>
                Enregistrer le champ piège
              </Button>
              {form.honeypotField !== null && (
                <Button
                  type="submit"
                  variant="ghost"
                  name="action"
                  value="clear"
                  formNoValidate
                  disabled={trapping}
                >
                  Retirer le champ piège
                </Button>
              )}
            </div>
            <FormProblem>{honeypotProblem}</FormProblem>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{form.status === "active" ? "Suspension" : "Formulaire suspendu"}</CardTitle>
          <CardDescription>
            Un formulaire suspendu refuse les nouveaux messages avec le statut 403. Les messages
            reçus, les destinations et l’adresse publique sont conservés.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={changeStatus} className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              {form.status === "active" && !confirming && (
                <Button onClick={() => setConfirming(true)}>Suspendre le formulaire</Button>
              )}
              {form.status === "active" && confirming && (
                <>
                  <Button
                    type="submit"
                    variant="default"
                    name="action"
                    value="suspend"
                    disabled={changing}
                  >
                    Confirmer la suspension
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(false)}>
                    Annuler
                  </Button>
                </>
              )}
              {form.status === "suspended" && (
                <Button
                  type="submit"
                  variant="default"
                  name="action"
                  value="reactivate"
                  disabled={changing}
                >
                  Réactiver le formulaire
                </Button>
              )}
            </div>
            <FormProblem>{statusProblem}</FormProblem>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

interface NewFormProps {
  readonly inboxId: Inbox["id"];
  readonly onChanged: () => Promise<void>;
  /** The public identifier of the form once it exists. */
  readonly onCreated: (publicId: Form["publicId"]) => void;
}

/** Adds a form to the organization. */
export function NewForm({ inboxId, onChanged, onCreated }: NewFormProps) {
  const [addProblem, add, adding] = useActionState(
    (_: string | null, data: FormData) =>
      attempt(async () => {
        const created = await createForm(
          inboxId,
          text(data, "name"),
          text(data, "businessContext"),
        );
        await onChanged();
        onCreated(created.publicId);
      }, "Le formulaire n’a pas pu être ajouté. Vérifiez les champs et réessayez."),
    null,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nom et activité</CardTitle>
        <CardDescription>
          Le formulaire reçoit une adresse d’envoi dès sa création. Elle ne change plus ensuite.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={add} className="grid gap-4">
          <TextField label="Nom du formulaire" name="name" required maxLength={100} />
          <TextAreaField
            label="Activité de l’organisation"
            name="businessContext"
            maxLength={2000}
            hint="Facultatif. Le filtre s’en sert pour juger si un message concerne votre activité."
          />
          <FormProblem>{addProblem}</FormProblem>
          <Button type="submit" variant="default" className="justify-self-start" disabled={adding}>
            Ajouter le formulaire
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
