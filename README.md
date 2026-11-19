# Rondyr

Rondyr est un backend de formulaires conçu pour tourner dans votre compte Cloudflare. Le Worker sert le dashboard React, son authentification Better Auth et l’endpoint `GET /health`. La [proposition d’architecture](architecture.md) décrit les étapes d’ingestion, de classification et de livraison à implémenter.

## Développement

Utilisez Node 24 selon `.nvmrc` et la version de pnpm déclarée dans `package.json`.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:migrate
pnpm dev
```

Vite affiche l’URL locale. Le dashboard répond sur `/` et le Worker renvoie `{"status":"ok"}` sur `/health`. Wrangler émule D1 et les files en local sans compte Cloudflare. `pnpm dev:alchemy` permet également d’exécuter la pile Alchemy avec son état local et applique les migrations à sa propre base D1 de développement.

Après une modification du schéma, lancez `pnpm db:generate --name nom-de-la-migration`, vérifiez le SQL et ajoutez le dossier généré au dépôt. Drizzle Kit et ORM utilisent le canal v1 RC pour partager le même format de migrations avec Alchemy, Wrangler et Vitest.

## Premier compte

Rondyr utilise Better Auth avec des sessions en D1. Les inscriptions publiques sont fermées. Pour créer le premier compte, générez deux valeurs distinctes avec `openssl rand -hex 32`. Renseignez `BETTER_AUTH_SECRET` et `RONDYR_SETUP_TOKEN` dans `.env` en local ou dans les secrets du stage pour Cloudflare.

Envoyez une requête au point d’installation depuis un terminal où `RONDYR_SETUP_TOKEN` contient la même valeur que le Worker. Utilisez son URL HTTPS pour un stage distant.

```sh
curl --fail-with-body --json @- \
  --header "Authorization: Bearer ${RONDYR_SETUP_TOKEN}" \
  http://localhost:5173/api/setup
```

Saisissez sur l’entrée standard un objet JSON avec les champs `name`, `email` et `password`, puis terminez avec `Ctrl+D`. Le mot de passe doit contenir de 12 à 128 caractères. Après la réponse `201`, connectez-vous sur `/`. Retirez le jeton d’installation de la configuration et redémarrez ou redéployez le Worker. D1 refuse toute deuxième création via ce point d’installation.

## Qualité

```sh
pnpm check
pnpm deploy:dry
```

La première commande vérifie le lint Oxlint, le format Oxfmt, les diagnostics Effect et TypeScript, les tests dans workerd, les tests des règles locales, les dépendances avec Knip et les migrations. La seconde construit le Worker et les assets, valide le bundle avec Wrangler et vérifie son budget de taille. La CI lance les deux commandes sans identifiants Cloudflare.

Le dashboard utilise aussi le compilateur React. Les règles viennent de `agentic-engineering-training@b5c49ff` et de `usine@011c3f740`. Les skills adaptés sont dans `.agents/skills`. Le plugin Oxlint et sa provenance sont décrits dans son [README](tooling/oxlint/README.md).

## Cloudflare

Activez un sous-domaine `workers.dev` pour le compte choisi. Connectez ce compte dans Alchemy et ciblez d’abord la préproduction. Renseignez `BETTER_AUTH_SECRET` et `BETTER_AUTH_URL` dans le fichier d’environnement du stage. Pour le Worker `rondyr-staging`, l’origine est `https://rondyr-staging.<sous-domaine>.workers.dev`. En production, Alchemy associe le nom d’hôte de `BETTER_AUTH_URL` au Worker `rondyr-prod` en tant que domaine personnalisé. Cloudflare gère son DNS et son certificat TLS.

```sh
pnpm exec alchemy profile edit --config alchemy-run.ts --add Cloudflare
pnpm deploy:plan --stage staging --env-file .env.staging
pnpm deploy --stage staging --env-file .env.staging
```

Alchemy peut proposer de créer son Worker d’état au premier plan ou déploiement. Les stages `staging` et `prod` utilisent des ressources applicatives distinctes. L’option `--profile` sélectionne un autre compte Cloudflare configuré dans Alchemy.

La pile déploie le Worker et ses assets Vite, applique les migrations D1 et crée les files de classification et de livraison. Le binding Workers AI est disponible dans le Worker déployé. `RONDYR_AI_GATEWAY=true` provisionne aussi un AI Gateway avec la collecte de logs désactivée. Les consumers, leurs files d’échec, le Cron de reprise et l’adaptateur IA font partie des étapes suivantes de l’architecture.

[Comptes et profils Alchemy](https://alchemy.run/cloudflare/accounts-and-tokens/) · [État partagé Alchemy](https://alchemy.run/state-store/)

## Déploiement par GitHub Actions

Un push sur `main`, y compris un merge, lance le déploiement `prod` après `pnpm check` et `pnpm deploy:dry`. Le workflow **Deploy** permet aussi de lancer `staging` manuellement.

Ajoutez `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID` aux secrets du dépôt. Pour `prod`, ajoutez le secret `BETTER_AUTH_SECRET_PROD` et la variable `BETTER_AUTH_URL_PROD` avec l’origine HTTPS de `rondyr-prod`, `https://rondyr.basaltbytes.com` pour le dépôt Basaltbytes. Le domaine doit appartenir à une zone active du même compte Cloudflare. Pour la préproduction, utilisez `BETTER_AUTH_SECRET_STAGING` et `BETTER_AUTH_URL_STAGING`. Le jeton d’installation est facultatif et se configure via `RONDYR_SETUP_TOKEN_PROD` ou `RONDYR_SETUP_TOKEN_STAGING`.

Créez un jeton Cloudflare de compte dédié à la CI. Sur le compte du Worker, attribuez `Workers Scripts Write`, `D1 Write`, `Queues Write`, `Secrets Store Read` et `Account Settings Read`. Pour la zone du domaine personnalisé, attribuez `Zone Read` et `Workers Routes Write`. Les noms correspondent aux groupes de permissions de l’API Cloudflare.

Initialisez une fois le stockage d’état Alchemy sur le compte Cloudflare avant le premier déploiement non interactif.

```sh
pnpm exec alchemy state bootstrap --backend cloudflare --config alchemy-run.ts
```

Sans `CLOUDFLARE_API_TOKEN`, GitHub Actions exécute les checks et indique que le déploiement a été ignoré.
