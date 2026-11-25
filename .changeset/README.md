# Changesets

Run `pnpm changeset` to record a user-facing change to `rondyr` or `@basaltbytes/emdash-plugin-rondyr`.

When pull requests with changeset files merge into `main`, the **Release** workflow opens or updates a **Version Packages** pull request that bumps package versions and updates each package's `CHANGELOG.md`. Merging that pull request publishes the matching git tags and GitHub Releases.
