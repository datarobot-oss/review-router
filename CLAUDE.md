# Review Router

GitHub Action that routes code reviews based on CODEOWNERS for DataRobot open-source repositories.

## Build

- **Always run `npm run build` before pushing** to regenerate `dist/`. CI will auto-commit it on PRs, but it's cleaner to include it in your commit.
- The `v1` floating tag is updated automatically on push to main via the `release.yml` workflow. No manual retagging needed.
