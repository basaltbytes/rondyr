---
name: react-app-structure
description: Organize React routes, features, shared components, hooks, and HTTP clients in Rondyr's Vite dashboard.
---

# Dashboard React

Les routes de `dashboard/src/routes` composent les fonctionnalités de `dashboard/src/features`. Une fonctionnalité peut importer ses propres modules et les dossiers partagés `components`, `hooks` et `lib`. Les dossiers partagés restent indépendants des routes et fonctionnalités.

Utiliser des exports nommés. Importer les modules du dossier courant avec un chemin relatif et ceux du reste du dashboard via `~/`. Passer par HTTP pour accéder au Worker. Aucun texte d’interface n’est écrit dans un composant : chaque texte est une clé i18next, en anglais dans `locales/en/translation.json` et en français dans `locales/fr/translation.json`, lue avec `useTranslation()`. Les deux fichiers ont les mêmes clés, ce que vérifie le typage de `lib/i18n.ts`. `pnpm i18n:check` signale un texte écrit en dur et une clé absente des fichiers.

Oxlint vérifie les imports, les appels de mémoïsation manuelle et les effets React. Si un effet synchronise une API externe, nommer cette API dans le commentaire d’exception demandé par la règle. Tester les calculs indépendamment du DOM et vérifier les interactions dans le navigateur quand elles en dépendent.
