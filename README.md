# Rondyr

Rondyr est un backend de formulaires conçu pour tourner dans votre compte Cloudflare. Le socle sert une page React et un endpoint `GET /health` depuis le même Worker. La [proposition d’architecture](architecture.md) décrit la v0.1, y compris les étapes d’ingestion, de classification et de livraison à implémenter.

## Développement

Utilisez Node 24 selon `.nvmrc` et la version de pnpm déclarée dans `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

Vite affiche l’URL locale. Le dashboard répond sur `/` et le Worker renvoie `{"status":"ok"}` sur `/health`. Wrangler émule D1 et les files en local sans compte Cloudflare. `pnpm dev:alchemy` permet également d’exécuter la pile Alchemy avec son état local et applique les migrations à sa propre base D1 de développement.

Après une modification du schéma, lancez `pnpm db:generate --name nom-de-la-migration`, vérifiez le SQL et ajoutez le dossier généré au dépôt. Drizzle Kit et ORM utilisent le canal v1 RC pour partager le même format de migrations avec Alchemy, Wrangler et Vitest.

## Qualité

```sh
pnpm check
pnpm deploy:dry
```

La première commande vérifie le lint Oxlint, le format Oxfmt, les diagnostics Effect et TypeScript, les tests dans workerd, les tests des règles locales, les dépendances avec Knip et les migrations. La seconde construit le Worker et les assets, valide le bundle avec Wrangler et vérifie son budget de taille. La CI lance les deux commandes sans identifiants Cloudflare.

Le dashboard utilise aussi le compilateur React. Les règles viennent de `agentic-engineering-training@b5c49ff` et de `usine@011c3f740`. Les skills adaptés sont dans `.agents/skills`. Le plugin Oxlint et sa provenance sont décrits dans son [README](tooling/oxlint/README.md).

## Cloudflare

Activez un sous-domaine `workers.dev` pour le compte choisi. Connectez ce compte dans Alchemy et ciblez d’abord la préproduction.

```sh
pnpm exec alchemy profile edit --config alchemy-run.ts --add Cloudflare
pnpm deploy:plan --stage staging
pnpm deploy --stage staging
```

Alchemy peut proposer de créer son Worker d’état au premier plan ou déploiement. Les stages `staging` et `prod` utilisent des ressources applicatives distinctes. L’option `--profile` sélectionne un autre compte Cloudflare configuré dans Alchemy.

La pile déploie le Worker et ses assets Vite, applique les migrations D1 et crée les files de classification et de livraison. Le binding Workers AI est disponible dans le Worker déployé. `RONDYR_AI_GATEWAY=true` provisionne aussi un AI Gateway avec la collecte de logs désactivée. Les consumers, leurs files d’échec, le Cron de reprise et l’adaptateur IA font partie des étapes suivantes de l’architecture.

[Comptes et profils Alchemy](https://alchemy.run/cloudflare/accounts-and-tokens/) · [État partagé Alchemy](https://alchemy.run/state-store/)
