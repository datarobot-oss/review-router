# Review Router

See AGENTS.md for project overview, structure, and commands.

## Claude-Specific

- **Don't commit `dist/` in a PR.** The Release workflow rebuilds it on main with `npm ci --ignore-scripts` and `npm run build` and commits `chore: rebuild dist`. Run `npm run build` locally to check that the bundle compiles, then discard the `dist/` changes.
- Run `npm run all` (lint + test + build) before declaring work complete.
- Tests live in `__tests__/` and mirror the `src/` file structure.
- The bundled config (`config/teams.yml`) is a placeholder. Real config lives in an external repo loaded at runtime.
