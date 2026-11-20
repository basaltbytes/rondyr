import { maxRecipients } from "@rondyr/deliveries/email";

export const statusLabels = {
  received: "Reçu",
  classifying: "En cours d’analyse",
  accepted: "Accepté",
  quarantined: "À vérifier",
  archived: "Archivé",
} as const;

export const reviewReasons = {
  "probable-spam": "Indésirable probable",
  ambiguous: "Classement incertain",
  "low-relevance": "Peu lié à votre activité",
  "classification-error": "Analyse indisponible",
  honeypot: "Champ piège rempli",
  repetition: "Envois répétés",
} as const;

export const destinationRefusals = {
  "invalid-url": "Cette adresse n’est pas une URL valide.",
  "not-https": "L’adresse doit commencer par https://.",
  credentials: "Retirez l’identifiant et le mot de passe de l’adresse.",
  "custom-port": "Utilisez le port HTTPS par défaut, sans numéro de port.",
  "local-hostname": "Ce nom d’hôte désigne un réseau local.",
  "reserved-address": "Cette adresse IP est privée ou réservée.",
  "worker-origin": "Un webhook ne peut pas viser Rondyr lui-même.",
} as const;

export const originRefusals = {
  "invalid-origin": "Saisissez une origine complète, par exemple https://www.example.com.",
  wildcard: "Les caractères génériques ne sont pas acceptés : ajoutez chaque origine.",
  "not-https":
    "L’origine doit commencer par https://. Seuls localhost et les adresses de boucle locale acceptent http://.",
  credentials: "Retirez l’identifiant et le mot de passe de l’origine.",
  "not-an-origin":
    "Retirez le chemin, les paramètres et l’ancre : gardez le schéma, l’hôte et le port.",
} as const;

export const formStatusLabels = {
  active: "Actif",
  suspended: "Suspendu",
} as const;

export const successUrlRefusals = {
  "invalid-url": "Saisissez une adresse complète, par exemple https://www.example.com/merci.",
  "not-https": "L’adresse doit commencer par https://.",
  credentials: "Retirez l’identifiant et le mot de passe de l’adresse.",
  "origin-not-listed":
    "Ajoutez d’abord l’origine de cette adresse aux origines autorisées du formulaire.",
} as const;

export const originInUse =
  "La redirection après envoi de ce formulaire pointe vers cette origine. Retirez d’abord la redirection.";

export const missingSecretsKey =
  "Le Worker n’a pas de clé RONDYR_SECRETS_KEY : impossible de créer un webhook ou de renouveler son secret.";

export const recipientRefusals = {
  "no-recipients": "Saisissez au moins une adresse e-mail.",
  "too-many-recipients": `Une destination accepte au plus ${maxRecipients} adresses.`,
  "invalid-address":
    "Une adresse n’est pas valide. Saisissez des adresses seules, comme equipe@example.com, sans nom ni chevrons.",
  "duplicate-address": "Une adresse apparaît deux fois.",
} as const;

export const missingEmailProvider =
  "L’envoi d’e-mails n’est pas configuré sur ce Worker : il faut RESEND_API_KEY et RONDYR_EMAIL_FROM.";

export const deliveryStatusLabels = {
  pending: "En attente",
  processing: "Envoi en cours",
  delivered: "Livrée",
  retrying: "Nouvel essai prévu",
  failed: "Échec",
} as const;

export const attemptOutcomeLabels = {
  delivered: "livrée",
  "retryable-failure": "échec temporaire",
  "permanent-failure": "échec définitif",
  interrupted: "interrompue avant son résultat",
} as const;
