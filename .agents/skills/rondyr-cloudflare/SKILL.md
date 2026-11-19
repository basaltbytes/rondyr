---
name: rondyr-cloudflare
description: Work on Rondyr's Cloudflare Worker, Alchemy stack, D1 migrations, bindings, static assets, or workerd tests.
---

# Cloudflare dans Rondyr

`alchemy-run.ts` définit les ressources distantes. `wrangler.json` décrit les bindings locaux utilisés par Vite, la génération de types et Vitest. Vérifier les deux fichiers quand un binding change. Alchemy injecte son plugin Vite dans ses propres exécutions. Respecter le garde-fou `ALCHEMY_CLOUDFLARE_VITE_INJECTED` dans la configuration Vite.

Garder les APIs Cloudflare dans les adaptateurs et les points d’entrée. Décrire les services consommés par le métier avec Effect et exposer les erreurs via son canal typé.

- `pnpm dev` démarre Vite et workerd. Après une modification D1, lancer `pnpm db:migrate` sur la base locale.
- `pnpm dev:alchemy` exerce le graphe local et applique les migrations à la base Alchemy. L’état des stages distants est dans Cloudflare.
- `pnpm db:generate --name nom-de-la-migration` génère le SQL et le snapshot du schéma. Ajouter une migration pour faire évoluer un schéma déjà appliqué.
- `pnpm test` utilise le vrai runtime Workers en local. `pnpm deploy:dry` valide le build et la configuration du Worker sans identifiants.

La pile Alchemy utilise un stage explicite pour un déploiement distant. Vérifier le profil Cloudflare avant un déploiement demandé. Le premier plan Alchemy peut proposer de provisionner son Worker d’état. Voir le README pour les commandes.
