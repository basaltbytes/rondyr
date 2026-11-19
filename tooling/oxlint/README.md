# Règles Oxlint de Rondyr

Le plugin provient de `basaltbytes/usine@011c3f740`, qui reprend entre autres `dmmulroy/anti-slop@6d53855`. La configuration applique au dashboard les règles React d’Usine et reprend les vérifications de nommage et d’imports du dépôt de formation.

Dans `dashboard/src`, les routes importent les fonctionnalités. Les fonctionnalités peuvent importer leur propre code et les modules partagés. Les modules partagés restent indépendants des routes et des fonctionnalités.

`pnpm test:lint` lance les tests du plugin avec Oxlint.

La redistribution du code repris d’Usine conserve sa [licence d’origine](LICENSE).
