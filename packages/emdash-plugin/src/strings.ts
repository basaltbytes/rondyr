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
    "blocked-term": "Blocked word or phrase",
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
    "token-malformed":
      "RONDYR_API_TOKEN isn't a Rondyr API token, which starts with rdr_ and has 47 characters. Submissions wait in the queue until it is set again with the token Rondyr showed.",
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
    statusUnavailable: "The queue of submissions for Rondyr can't be read.",
    unqueued:
      "{count} submissions accepted since {date} could not be put in the queue for Rondyr, so Rondyr doesn't have them. The Forms plugin kept them: an administrator can download them in Rondyr settings.",
  },
  widget: {
    toReview: "Messages to review",
    open: "Open messages",
  },
  settings: {
    title: "Rondyr",
    adminOnly: "Only administrators can change these settings.",
    noForms: "No forms yet. Create one under Forms first.",
    noDeclaredForms: "Declare a form in astro.config.mjs first.",
    rondyrForm: "Rondyr form",
    rondyrFormHelp:
      "Several forms can share a Rondyr form, such as the language versions of one form. A message goes to the recipients of the form it was sent from.",
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
    formsEmailsHeld:
      "The Forms plugin doesn't send its own notification or daily digest for this form: the recipients below get each message once Rondyr accepts it. A post that doesn't go through /api/form still gets the Forms plugin's emails.",
    autoReplyHeld:
      "The auto-reply set in Forms goes to the visitor when Rondyr accepts the message, not before. A message in quarantine gets it only if someone accepts it.",
    formsEmailsNotHeld:
      "The Forms plugin emailed the last message of this form as soon as it arrived, before Rondyr classified it, because the site loads formsPlugin(). In astro.config.mjs, replace it with formsWithoutSubmissions() or formsWithRondyr() from @basaltbytes/emdash-plugin-rondyr.",
    bypassed:
      "{count} submissions of this form, from {first} to {last}, were posted straight to the Forms plugin, so Rondyr doesn't have them. The Forms plugin sent its own emails for them. The Forms plugin's Form block posts this way: render the form with a block that posts to /api/form instead.",
    unqueued:
      "{count} submissions of this form, from {first} to {last}, could not be put in the queue for Rondyr, so Rondyr doesn't have them and sent no email for them. The Forms plugin kept them: download its submissions since then to read them.",
    download: "Download from the Forms plugin",
    clearUnqueued: "Mark as handled",
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
    "blocked-term": "Mot ou expression bloqué",
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
    "token-malformed":
      "RONDYR_API_TOKEN n’est pas un jeton d’API Rondyr, qui commence par rdr_ et compte 47 caractères. Les soumissions attendent dans la file jusqu’à ce qu’il soit de nouveau défini avec le jeton affiché par Rondyr.",
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
    statusUnavailable: "La file des soumissions pour Rondyr est illisible.",
    unqueued:
      "{count} soumissions acceptées depuis le {date} n’ont pas pu entrer dans la file pour Rondyr : Rondyr ne les a pas. Le plugin Forms les a gardées : un administrateur peut les télécharger dans les réglages Rondyr.",
  },
  widget: {
    toReview: "Messages à examiner",
    open: "Ouvrir les messages",
  },
  settings: {
    title: "Rondyr",
    adminOnly: "Seuls les administrateurs peuvent modifier ces réglages.",
    noForms: "Aucun formulaire pour le moment. Créez-en un dans Formulaires.",
    noDeclaredForms: "Déclarez d’abord un formulaire dans astro.config.mjs.",
    rondyrForm: "Formulaire Rondyr",
    rondyrFormHelp:
      "Plusieurs formulaires peuvent partager un formulaire Rondyr, comme les versions d’un même formulaire dans plusieurs langues. Un message part vers les destinataires du formulaire depuis lequel il a été envoyé.",
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
    formsEmailsHeld:
      "Le plugin Forms n’envoie ni sa propre notification ni son résumé quotidien pour ce formulaire : les destinataires ci-dessous reçoivent chaque message une fois que Rondyr l’accepte. Un envoi qui ne passe pas par /api/form reçoit toujours les e-mails du plugin Forms.",
    autoReplyHeld:
      "La réponse automatique réglée dans Forms part vers le visiteur quand Rondyr accepte le message, pas avant. Un message en quarantaine ne la reçoit que si quelqu’un l’accepte.",
    formsEmailsNotHeld:
      "Le plugin Forms a envoyé par e-mail le dernier message de ce formulaire dès son arrivée, avant que Rondyr le classe, parce que le site charge formsPlugin(). Dans astro.config.mjs, remplacez-le par formsWithoutSubmissions() ou formsWithRondyr() de @basaltbytes/emdash-plugin-rondyr.",
    bypassed:
      "{count} soumissions de ce formulaire, du {first} au {last}, ont été envoyées directement au plugin Forms : Rondyr ne les a pas. Le plugin Forms a envoyé ses propres e-mails pour elles. Le bloc Form du plugin Forms envoie de cette façon : affichez le formulaire avec un bloc qui envoie vers /api/form.",
    unqueued:
      "{count} soumissions de ce formulaire, du {first} au {last}, n’ont pas pu entrer dans la file pour Rondyr : Rondyr ne les a pas et n’a envoyé aucun e-mail pour elles. Le plugin Forms les a gardées : téléchargez ses soumissions depuis cette date pour les lire.",
    download: "Télécharger depuis le plugin Forms",
    clearUnqueued: "Marquer comme traité",
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
