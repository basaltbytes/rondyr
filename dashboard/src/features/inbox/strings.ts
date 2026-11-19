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
