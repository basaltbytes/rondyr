# Rondyr

Rondyr est un backend de formulaires auto-hébergé sur Cloudflare. Lire [architecture.md](architecture.md) avant de modifier les contrats publics, le modèle de données ou le traitement des soumissions. La section 12 décrit l’ordre des travaux. Le README décrit ce que le dépôt permet déjà d’exécuter, et [docs/deployment.md](docs/deployment.md) décrit le déploiement.

## Code

- Garder un seul Worker applicatif. Le domaine reste indépendant de Cloudflare, Drizzle et Alchemy. Les ports déclarent les services Effect. Les adaptateurs fournissent les layers.
- Utiliser Effect 4 et Effect Schema pour le métier, les erreurs et les frontières de données. Composer les layers à l’entrée du Worker. Garder les fichiers en kebab-case, sauf conventions des outils et fichiers générés.
- Réserver les migrations à l’outillage de développement et au déploiement. Versionner les migrations et snapshots Drizzle dans `database/migrations`.
- Pour l’ingestion, une réponse `202` implique la persistance atomique de la soumission et de son événement outbox. Les futurs consumers doivent tolérer les événements dupliqués.
- Utiliser des noms et commentaires de code en anglais. Écrire le README et `docs/` en anglais. Écrire `architecture.md`, les issues et les textes de l’interface en français.

## Travail sur une issue

Les issues GitHub sont la feuille de route. Une issue est prête quand aucune issue ouverte ne la bloque (relation « blocked by » de GitHub, reprise dans sa section « Ordre »). La section 12 de l’architecture donne l’ordre d’ensemble.

- Une issue par branche et par PR. Titre et description de la PR en français. Écrire `Closes #n` seulement si chaque critère d’acceptation est rempli ; sinon `Refs #n` et la liste de ce qui manque.
- Ne pas pousser sur `main` et ne pas déployer : un push sur `main` déploie la production et applique les migrations D1.
- Une seule issue portant le label `migration` à la fois. Deux migrations Drizzle générées en parallèle entrent en conflit sur leurs snapshots. Générer avec `pnpm db:generate --name …`, relire le SQL, et ne jamais reconstruire `forms` ni `submissions` : sur D1, la suppression de la table supprimerait en cascade les lignes des tables liées.
- Un message réel n’est jamais perdu volontairement. Dans le doute, le message est enregistré et mis en quarantaine avec un motif ; un refus n’est admis que là où l’issue le décide.
- Le contenu d’un message reste dans `submissions.fields`. Il ne va ni dans les journaux, ni dans les événements du domaine, ni dans un résumé d’erreur.
- Les routes et les jobs n’importent que des ports. Les requêtes d’exécution sont du SQL préparé, décodé par Effect Schema.
- Un réglage ou un secret nouveau est facultatif au déploiement : sans lui, le déploiement réussit et la fonction concernée répond par une erreur claire.
- Les deux classificateurs restent disponibles par `RONDYR_CLASSIFIER`. Tout changement de règle ou d’entrée du classificateur se mesure avec `pnpm evaluate` avant et après, et incrémente `rulesVersion`.
- Les tests d’intégration tournent dans workerd contre le Worker construit, sans mock de module. Les services externes sont simulés dans `vitest.config.ts` (Workers AI, destinataire de webhook, Resend). Ne jamais affaiblir une assertion existante ni désactiver une règle de lint.
- Le rapport de fin de travail dit ce qui est fait pour chaque critère, les résultats exacts de `pnpm check` et de `pnpm deploy:dry`, les décisions que l’issue ne tranchait pas, et ce qui n’a pas été vérifié.

## Skills locaux

- [effect-ts](.agents/skills/effect-ts/SKILL.md) pour le code Effect et ses tests.
- [coding-guidelines](.agents/skills/coding-guidelines/SKILL.md) pour les règles de domaine et la revue de code.
- [rondyr-cloudflare](.agents/skills/rondyr-cloudflare/SKILL.md) pour Alchemy, les bindings Workers, D1 et workerd.
- [react-app-structure](.agents/skills/react-app-structure/SKILL.md) pour le code dans `dashboard/src`.
- [anti-slop-writing](.agents/skills/anti-slop-writing/SKILL.md) pour la documentation et les textes de l’interface.

## Vérification

Exécuter `pnpm check` avant une PR. Exécuter aussi `pnpm deploy:dry` si la modification concerne le Worker, les assets ou la configuration de la plateforme. La CI vérifie les deux commandes. Un déploiement se fait avec Alchemy sur le stage explicite et le profil autorisé.
