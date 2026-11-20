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

export const missingSecretsKey =
  "Le Worker n’a pas de clé RONDYR_SECRETS_KEY : impossible de créer un webhook ou de renouveler son secret.";
