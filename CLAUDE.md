# Review Router

See AGENTS.md for project overview, structure, and commands.

## Claude-Specific

- **Always rebuild `dist/` before pushing, in the commit that changes `src/`.** Run `npm ci --ignore-scripts` first, then `npm run build`. CI builds from the lockfile, so a stale `node_modules` gives a different bundle and CI adds a `chore: rebuild dist` commit to the PR.
- Run `npm run all` (lint + test + build) before declaring work complete.
- Tests live in `__tests__/` and mirror the `src/` file structure.
- The bundled config (`config/teams.yml`) is a placeholder. Real config lives in an external repo loaded at runtime.
