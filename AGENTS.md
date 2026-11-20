# Rondyr

Rondyr est un backend de formulaires auto-hébergé sur Cloudflare. Lire [architecture.md](architecture.md) avant de modifier les contrats publics, le modèle de données ou le traitement des soumissions. La section 12 décrit l’ordre des travaux. Le README décrit ce que le dépôt permet déjà d’exécuter, et [docs/deployment.md](docs/deployment.md) décrit le déploiement.

## Code

- Garder un seul Worker applicatif. Le domaine reste indépendant de Cloudflare, Drizzle et Alchemy. Les ports déclarent les services Effect. Les adaptateurs fournissent les layers.
- Utiliser Effect 4 et Effect Schema pour le métier, les erreurs et les frontières de données. Composer les layers à l’entrée du Worker. Garder les fichiers en kebab-case, sauf conventions des outils et fichiers générés.
- Réserver les migrations à l’outillage de développement et au déploiement. Versionner les migrations et snapshots Drizzle dans `database/migrations`.
- Pour l’ingestion, une réponse `202` implique la persistance atomique de la soumission et de son événement outbox. Les futurs consumers doivent tolérer les événements dupliqués.
- Utiliser des noms et commentaires de code en anglais. Écrire le README et `docs/` en anglais. Écrire `architecture.md`, les issues et les textes de l’interface en français.

## Skills locaux

- [effect-ts](.agents/skills/effect-ts/SKILL.md) pour le code Effect et ses tests.
- [coding-guidelines](.agents/skills/coding-guidelines/SKILL.md) pour les règles de domaine et la revue de code.
- [rondyr-cloudflare](.agents/skills/rondyr-cloudflare/SKILL.md) pour Alchemy, les bindings Workers, D1 et workerd.
- [react-app-structure](.agents/skills/react-app-structure/SKILL.md) pour le code dans `dashboard/src`.
- [anti-slop-writing](.agents/skills/anti-slop-writing/SKILL.md) pour la documentation et les textes de l’interface.

## Vérification

Exécuter `pnpm check` avant une PR. Exécuter aussi `pnpm deploy:dry` si la modification concerne le Worker, les assets ou la configuration de la plateforme. La CI vérifie les deux commandes. Un déploiement se fait avec Alchemy sur le stage explicite et le profil autorisé.
