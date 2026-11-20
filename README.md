# Rondyr

Rondyr est un backend de formulaires conçu pour tourner dans votre compte Cloudflare. Le Worker reçoit les soumissions, les classe avec Jev et sert la boîte de réception React protégée par Better Auth. Les messages mis en quarantaine restent consultables et peuvent être acceptés ou archivés. La [proposition d’architecture](architecture.md) décrit le périmètre de la v0.1.

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

Lancez le script depuis la racine du dépôt avec Node et `curl`. Pour un stage distant, passez l’origine HTTPS du Worker.

```sh
./scripts/setup-owner.sh http://localhost:5173
```

Le script lit `RONDYR_SETUP_TOKEN` dans l’environnement ou le demande dans le terminal. Utilisez la même valeur que celle configurée sur le Worker. Le script vous demande aussi le nom, l’adresse e-mail et le mot de passe du compte. Le mot de passe doit contenir de 12 à 128 caractères. Après la réponse `201`, connectez-vous sur `/`. Retirez le jeton d’installation de la configuration et redémarrez ou redéployez le Worker. D1 refuse toute deuxième création via ce point d’installation.

## Recevoir un premier message

Après connexion, créez une boîte de réception en indiquant le nom de l’organisation et du formulaire. Le contexte métier est facultatif. Ouvrez **Adresses des formulaires** pour copier l’URL publique.

```sh
curl --json '{"email":"visiteur@example.com","message":"Reste-t-il des places pour le cours ?"}' \
  http://localhost:5173/f/IDENTIFIANT_PUBLIC
```

Un formulaire HTML peut utiliser la même URL dans son attribut `action`, avec `method="post"`. Le corps de la requête peut peser jusqu’à 16 Kio et contenir de 1 à 32 champs texte. Un formulaire accepte jusqu’à 30 soumissions par minute. D1 enregistre le message et l’événement d’envoi en file avant la réponse `202`. La réponse JSON inclut `submission-id`. Un navigateur qui demande du HTML affiche une page de confirmation.

Le Cron vérifie la file d’attente D1 chaque minute. Les seuils initiaux envoient les scores de spam à partir de 0,30 en revue et distinguent le spam probable à partir de 0,70. Avec un contexte configuré, un score de pertinence inférieur à 0,35 peut aussi déclencher une revue. Utilisez **Actualiser** pour voir le résultat de l’analyse. En développement local, le classificateur sans binding Workers AI place les messages en quarantaine avec le motif **Analyse indisponible**. Vous pouvez les ouvrir, les accepter ou les archiver.

Si vous avez déjà une organisation créée en SQL, ajoutez une ligne dans `organization_members` avec son `organization_id` et l’identifiant Better Auth `user_id` du compte autorisé.

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
pnpm run deploy --stage staging --env-file .env.staging
```

Alchemy peut proposer de créer son Worker d’état au premier plan ou déploiement. Les stages `staging` et `prod` utilisent des ressources applicatives distinctes. L’option `--profile` sélectionne un autre compte Cloudflare configuré dans Alchemy.

La pile déploie le Worker avec ses assets Vite et les Durable Objects du modèle Alchemy Domain. Elle applique les migrations D1 et configure la file de classification, sa file d’échec et le Cron de reprise. Le Worker déployé utilise le binding Workers AI pour Jev. `RONDYR_AI_GATEWAY=true` provisionne aussi un AI Gateway avec la collecte de logs désactivée. La file de livraison est provisionnée pour l’étape de distribution.

Jev est le classificateur par défaut. Pour utiliser OpenAI Decisions avec GPT-6 Luna, définissez `RONDYR_CLASSIFIER=openai` dans l’environnement du stage. Avec GitHub Actions, utilisez la variable `RONDYR_CLASSIFIER_STAGING` ou `RONDYR_CLASSIFIER_PROD`. Le choix s’applique à tous les formulaires du stage après redéploiement. Le Worker appelle `openai/decisions` via le binding `AI` et le gateway `default`. Avec la facturation unifiée de Cloudflare, le Worker utilise les crédits du compte, sans clé OpenAI dans Rondyr. [Modèle Decisions](https://developers.cloudflare.com/ai/models/openai/decisions/) · [Facturation unifiée](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)

[Comptes et profils Alchemy](https://alchemy.run/cloudflare/accounts-and-tokens/) · [État partagé Alchemy](https://alchemy.run/state-store/)

## Déploiement par GitHub Actions

Un push sur `main`, y compris un merge, lance le déploiement `prod` après `pnpm check` et `pnpm deploy:dry`. Le workflow **Deploy** permet aussi de lancer `staging` manuellement.

Ajoutez `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID` aux secrets du dépôt. Pour `prod`, ajoutez le secret `BETTER_AUTH_SECRET_PROD` et la variable `BETTER_AUTH_URL_PROD` avec l’origine HTTPS de `rondyr-prod`, `https://rondyr.basaltbytes.com` pour le dépôt Basaltbytes. Le domaine doit appartenir à une zone active du même compte Cloudflare. Pour la préproduction, utilisez `BETTER_AUTH_SECRET_STAGING` et `BETTER_AUTH_URL_STAGING`. Le jeton d’installation est facultatif et se configure via `RONDYR_SETUP_TOKEN_PROD` ou `RONDYR_SETUP_TOKEN_STAGING`.

Créez un jeton Cloudflare de compte dédié à la CI. Sur le compte du Worker, attribuez `Workers Scripts Write`, `D1 Write`, `Queues Write`, `Account Settings Read` et la permission **Account Secrets Store Edit** (`Secrets Store Write` dans Alchemy). Pour la zone du domaine personnalisé, attribuez `Zone Read` et `Workers Routes Write`. La permission d’édition du Secrets Store permet à Alchemy de lier le secret d’état à son Worker de prévisualisation. [Permissions Secrets Store](https://developers.cloudflare.com/secrets-store/access-control/)

Initialisez une fois le stockage d’état Alchemy sur le compte Cloudflare avant le premier déploiement non interactif.

```sh
pnpm exec alchemy state bootstrap --backend cloudflare --config alchemy-run.ts
```

Sans `CLOUDFLARE_API_TOKEN`, GitHub Actions exécute les checks et indique que le déploiement a été ignoré.
