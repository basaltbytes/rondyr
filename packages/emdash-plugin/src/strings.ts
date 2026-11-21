/**
 * Every text the plugin shows in the EmDash admin, in English and French. The
 * admin page picks the language of the admin's `<html lang>`.
 */
const en = {
  messages: {
    title: "Messages",
    folders: { accepted: "Inbox", quarantined: "To review", archived: "Archived" },
    allForms: "All forms",
    formFilter: "Form",
    empty: "No messages in this folder.",
    loadMore: "Load more",
    loading: "Loading…",
    back: "Back to the list",
    received: "Received {date}",
    reasonLabel: "Why it needs a review",
    accept: "Accept",
    archive: "Archive",
    working: "Saving…",
    alreadyDecided: "Someone already decided on this message. The list is up to date again.",
    noFields: "This message has no fields.",
  },
  status: {
    received: "Received",
    classifying: "Being analyzed",
    accepted: "Accepted",
    quarantined: "To review",
    archived: "Archived",
  },
  reasons: {
    "probable-spam": "Probable spam",
    ambiguous: "Uncertain classification",
    "low-relevance": "Unrelated to your business",
    solicitation: "Unsolicited sales outreach",
    "classification-error": "Analysis unavailable",
    honeypot: "Honeypot field filled",
    repetition: "Repeated submissions",
    "turnstile-failed": "Turnstile verification failed",
    quota: "Daily classification quota reached",
    unknown: "Held for review",
  },
  errors: {
    unreachable: "Rondyr can't be reached right now. Nothing is shown until it answers again.",
    unauthorized:
      "Rondyr refused the API token. Create a token in Rondyr, set it as RONDYR_API_TOKEN, and deploy the site again.",
    "not-found": "Rondyr doesn't know this message, or it belongs to another organization.",
    conflict: "Someone already decided on this message.",
    unexpected: "Rondyr sent an answer this plugin doesn't understand.",
    "token-missing":
      "RONDYR_API_TOKEN isn't set. Submissions wait in the queue, and this page can't read Rondyr.",
    failed: "The request failed. Try again in a moment.",
  },
  setup: {
    webhookSecretMissing:
      "RONDYR_WEBHOOK_SECRET isn't set. The site refuses Rondyr's webhook, so accepted messages send no email.",
  },
  queue: {
    summary:
      "Waiting to be sent to Rondyr: {pending}. Failed: {failed}. Without a Rondyr form: {unlinked}.",
    retry: "Retry failed submissions",
    retrying: "Retrying…",
  },
  widget: {
    toReview: "Messages to review",
    open: "Open messages",
  },
  settings: {
    title: "Rondyr",
    adminOnly: "Only administrators can change these settings.",
    noForms: "No forms yet. Create one under Forms first.",
    rondyrForm: "Rondyr form",
    notLinked: "Not linked",
    recipients: "Notification recipients",
    recipientsHelp:
      "One address per line. Each one gets an email when Rondyr accepts a message of this form.",
    save: "Save",
    saved: "Saved.",
    invalidEmail: "{email} isn't a valid email address.",
    tooManyRecipients: "A form can have at most {max} recipients.",
    webhookUrl: "Webhook URL to add as a destination of each linked Rondyr form",
    unavailable: "The list of Rondyr forms can't be read:",
    formsEmails:
      "This form still sends its own notification emails or an auto-reply from the Forms plugin, before Rondyr classifies the message. Remove them in Forms, in the settings of {name}.",
  },
};

export type Strings = typeof en;

const fr: Strings = {
  messages: {
    title: "Messages",
    folders: { accepted: "Boîte de réception", quarantined: "À examiner", archived: "Archivés" },
    allForms: "Tous les formulaires",
    formFilter: "Formulaire",
    empty: "Aucun message dans ce dossier.",
    loadMore: "Afficher plus",
    loading: "Chargement…",
    back: "Retour à la liste",
    received: "Reçu le {date}",
    reasonLabel: "Pourquoi il faut l’examiner",
    accept: "Accepter",
    archive: "Archiver",
    working: "Enregistrement…",
    alreadyDecided: "Quelqu’un a déjà tranché ce message. La liste est de nouveau à jour.",
    noFields: "Ce message n’a aucun champ.",
  },
  status: {
    received: "Reçu",
    classifying: "En cours d’analyse",
    accepted: "Accepté",
    quarantined: "À examiner",
    archived: "Archivé",
  },
  reasons: {
    "probable-spam": "Indésirable probable",
    ambiguous: "Classement incertain",
    "low-relevance": "Peu lié à votre activité",
    solicitation: "Démarchage commercial non sollicité",
    "classification-error": "Analyse indisponible",
    honeypot: "Champ piège rempli",
    repetition: "Envois répétés",
    "turnstile-failed": "Échec de la vérification Turnstile",
    quota: "Plafond quotidien de classification atteint",
    unknown: "Mis de côté pour examen",
  },
  errors: {
    unreachable:
      "Rondyr ne répond pas pour le moment. Rien n’est affiché tant qu’il ne répond pas.",
    unauthorized:
      "Rondyr refuse le jeton d’API. Créez un jeton dans Rondyr, enregistrez-le dans RONDYR_API_TOKEN, puis redéployez le site.",
    "not-found": "Rondyr ne connaît pas ce message, ou il appartient à une autre organisation.",
    conflict: "Quelqu’un a déjà tranché ce message.",
    unexpected: "Rondyr a envoyé une réponse que ce plugin ne comprend pas.",
    "token-missing":
      "RONDYR_API_TOKEN n’est pas défini. Les soumissions attendent dans la file, et cette page ne peut pas lire Rondyr.",
    failed: "La requête a échoué. Réessayez dans un instant.",
  },
  setup: {
    webhookSecretMissing:
      "RONDYR_WEBHOOK_SECRET n’est pas défini. Le site refuse le webhook de Rondyr : les messages acceptés n’envoient aucun e-mail.",
  },
  queue: {
    summary:
      "En attente d’envoi à Rondyr : {pending}. En échec : {failed}. Sans formulaire Rondyr : {unlinked}.",
    retry: "Réessayer les soumissions en échec",
    retrying: "Nouvel essai…",
  },
  widget: {
    toReview: "Messages à examiner",
    open: "Ouvrir les messages",
  },
  settings: {
    title: "Rondyr",
    adminOnly: "Seuls les administrateurs peuvent modifier ces réglages.",
    noForms: "Aucun formulaire pour le moment. Créez-en un dans Formulaires.",
    rondyrForm: "Formulaire Rondyr",
    notLinked: "Non relié",
    recipients: "Destinataires des notifications",
    recipientsHelp:
      "Une adresse par ligne. Chacune reçoit un e-mail quand Rondyr accepte un message de ce formulaire.",
    save: "Enregistrer",
    saved: "Enregistré.",
    invalidEmail: "{email} n’est pas une adresse e-mail valide.",
    tooManyRecipients: "Un formulaire a au plus {max} destinataires.",
    webhookUrl: "URL du webhook à ajouter comme destination de chaque formulaire Rondyr relié",
    unavailable: "La liste des formulaires Rondyr est illisible :",
    formsEmails:
      "Ce formulaire envoie encore ses propres e-mails de notification ou une réponse automatique depuis le plugin Forms, avant que Rondyr classe le message. Supprimez-les dans Forms, dans les réglages de {name}.",
  },
};

export const strings = { en, fr } as const;

export type Language = keyof typeof strings;

/** French when the admin is in French, English otherwise. */
export function languageOf(tag: string): Language {
  return tag.toLowerCase().startsWith("fr") ? "fr" : "en";
}

/** Replace each `{name}` of a text with its value. */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
