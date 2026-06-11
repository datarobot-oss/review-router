# Review Router

See AGENTS.md for project overview, structure, and commands.

## Claude-Specific

- **Always run `npm run build` before pushing** to regenerate `dist/`.
- Run `npm run all` (lint + test + build) before declaring work complete.
- Tests live in `__tests__/` and mirror the `src/` file structure.
- The bundled config (`config/teams.yml`) is a placeholder. Real config lives in an external repo loaded at runtime.
