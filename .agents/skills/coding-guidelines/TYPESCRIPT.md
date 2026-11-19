# Domaine TypeScript avec Effect Schema

Lire le [skill effect-ts](../effect-ts/SKILL.md) pour les exemples qui correspondent à la version installée.

- Décoder les requêtes HTTP, messages Queue et résultats d’adaptateurs à leur frontière. Passer des valeurs validées et typées au métier.
- Marquer les identifiants avec `Schema.brand` et modéliser les variantes de domaine avec `Schema.TaggedClass` et `Schema.Union`.
- Décrire les erreurs métier avec `Schema.TaggedError`. Déclarer les dépendances remplaçables comme services Effect et tester les cas d’usage via leurs layers.
- Les écritures qui engagent la même transition métier doivent réussir ou échouer ensemble. Pour D1, utiliser des instructions atomiques ou un batch natif et tester la contrainte sur workerd.
