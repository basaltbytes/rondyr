# Configuration Effect dans Rondyr

Consulter `package.json` pour la version d’Effect et conserver les paquets de plateforme et de test au même niveau. Effect 4 expose HTTP via `effect/http` et utilise la configuration de diagnostics Effect dans `tsconfig.json`.

- `pnpm typecheck` génère les types Workers puis exécute `effect-tsgo tsc`. Le lanceur intègre les diagnostics sans modifier les binaires installés.
- Compiler le code avec Vite et conserver la résolution TypeScript `Bundler`. Vérifier la version TypeScript sélectionnée dans l’éditeur.
- Utiliser `@effect/vitest` pour les tests Effect. Les tests Cloudflare tournent sur workerd via `@cloudflare/vitest-plugin`.
- Pour le cycle de vie du Worker et D1, lire le [skill Cloudflare du projet](../../rondyr-cloudflare/SKILL.md).
