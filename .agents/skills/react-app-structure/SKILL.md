---
name: react-app-structure
description: Organize React routes, features, shared components, hooks, and HTTP clients in Rondyr's Vite dashboard.
---

# Dashboard React

Les routes de `dashboard/src/routes` composent les fonctionnalités de `dashboard/src/features`. Une fonctionnalité peut importer ses propres modules et les dossiers partagés `components`, `hooks` et `lib`. Les dossiers partagés restent indépendants des routes et fonctionnalités.

Utiliser des exports nommés. Importer les modules du dossier courant avec un chemin relatif et ceux du reste du dashboard via `~/`. Passer par HTTP pour accéder au Worker. Garder les textes partagés dans `lib/strings.ts` et les textes d’une fonctionnalité dans son propre `strings.ts` quand une extraction s’impose.

Oxlint vérifie les imports, les appels de mémoïsation manuelle et les effets React. Si un effet synchronise une API externe, nommer cette API dans le commentaire d’exception demandé par la règle. Tester les calculs indépendamment du DOM et vérifier les interactions dans le navigateur quand elles en dépendent.
