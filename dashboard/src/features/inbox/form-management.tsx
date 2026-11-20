import { Option, Schema } from "effect";
import { useActionState, useState } from "react";

import {
  clearSuccessUrl,
  createForm,
  FormRequestFailed,
  setFormStatus,
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

function FormSettings({ inboxId, form, onChanged }: FormSettingsProps) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
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

  return (
    <section aria-label={`Réglages du formulaire ${form.name}`}>
      <h3>{form.name}</h3>
      <p>
        {formStatusLabels[form.status]} · <code>{publicUrl}</code>
      </p>
      {form.status === "suspended" && (
        <p>
          Ce formulaire refuse les nouveaux messages. Les messages reçus restent dans la boîte de
          réception.
        </p>
      )}
      <p>
        {form.businessContext === null
          ? "Aucune activité décrite : la pertinence des messages n’est pas évaluée."
          : `Activité : ${form.businessContext}`}
      </p>
      {editing ? (
        <form action={edit} className="auth-form">
          <label>
            Nom du formulaire{" "}
            <input name="name" required maxLength={100} defaultValue={form.name} />
          </label>
          <label>
            Activité de l’organisation{" "}
            <textarea
              name="businessContext"
              maxLength={2000}
              placeholder="Facultatif"
              defaultValue={form.businessContext ?? ""}
            />
          </label>
          <div className="inbox-actions">
            <button type="submit" disabled={saving}>
              Enregistrer
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Annuler
            </button>
          </div>
        </form>
      ) : (
        <div className="inbox-actions">
          <button type="button" onClick={() => setEditing(true)}>
            Modifier le nom ou l’activité
          </button>
        </div>
      )}
      {editProblem !== null && <p role="alert">{editProblem}</p>}
      {form.status === "active" && !confirming && (
        <div className="inbox-actions">
          <button type="button" onClick={() => setConfirming(true)}>
            Suspendre le formulaire
          </button>
        </div>
      )}
      {form.status === "active" && confirming && (
        <form action={changeStatus}>
          <p>
            Un formulaire suspendu refuse les nouveaux messages avec le statut 403. Les messages
            reçus, les destinations et l’adresse publique sont conservés.
          </p>
          <div className="inbox-actions">
            <button type="submit" name="action" value="suspend" disabled={changing}>
              Confirmer la suspension
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Annuler
            </button>
          </div>
        </form>
      )}
      {form.status === "suspended" && (
        <form action={changeStatus} className="inbox-actions">
          <button type="submit" name="action" value="reactivate" disabled={changing}>
            Réactiver le formulaire
          </button>
        </form>
      )}
      {statusProblem !== null && <p role="alert">{statusProblem}</p>}
      <p>
        Après un envoi depuis un formulaire HTML :{" "}
        {form.successUrl === null ? (
          "page de confirmation de Rondyr."
        ) : (
          <>
            redirection vers <code>{form.successUrl}</code>.
          </>
        )}{" "}
        L’origine de l’adresse doit figurer dans les origines autorisées du formulaire.
      </p>
      <form action={changeRedirect} className="inbox-actions">
        <label>
          Adresse de redirection{" "}
          <input
            type="url"
            name="url"
            required
            maxLength={2048}
            placeholder="https://www.example.com/merci"
          />
        </label>
        <button type="submit" name="action" value="set" disabled={redirecting}>
          Enregistrer
        </button>
        {form.successUrl !== null && (
          <button type="submit" name="action" value="clear" formNoValidate disabled={redirecting}>
            Retirer la redirection
          </button>
        )}
      </form>
      {redirectProblem !== null && <p role="alert">{redirectProblem}</p>}
    </section>
  );
}

interface FormManagementProps {
  readonly inbox: Inbox;
  readonly onChanged: () => Promise<void>;
}

/** The forms of an organization: public URL, status, name, business context and redirect. */
export function FormManagement({ inbox, onChanged }: FormManagementProps) {
  const [addProblem, add, adding] = useActionState(
    (_: string | null, data: FormData) =>
      attempt(async () => {
        await createForm(inbox.id, text(data, "name"), text(data, "businessContext"));
        await onChanged();
      }, "Le formulaire n’a pas pu être ajouté. Vérifiez les champs et réessayez."),
    null,
  );

  return (
    <>
      {inbox.forms.map((form) => (
        <FormSettings key={form.publicId} inboxId={inbox.id} form={form} onChanged={onChanged} />
      ))}
      <form action={add} className="auth-form">
        <h3>Nouveau formulaire</h3>
        <label>
          Nom du formulaire <input name="name" required maxLength={100} />
        </label>
        <label>
          Activité de l’organisation{" "}
          <textarea name="businessContext" maxLength={2000} placeholder="Facultatif" />
        </label>
        {addProblem !== null && <p role="alert">{addProblem}</p>}
        <button type="submit" disabled={adding}>
          Ajouter le formulaire
        </button>
      </form>
    </>
  );
}
