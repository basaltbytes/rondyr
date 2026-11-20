export const reviewReasons = {
  "probable-spam": "Indésirable probable",
  ambiguous: "Classement incertain",
  "low-relevance": "Peu lié à votre activité",
  "classification-error": "Analyse indisponible",
  honeypot: "Champ piège rempli",
  repetition: "Envois répétés",
} as const;

export const deliveryStatusLabels = {
  pending: "En attente",
  processing: "Envoi en cours",
  delivered: "Livrée",
  retrying: "Nouvel essai prévu",
  failed: "Échec",
} as const;
