# Review Router

See AGENTS.md for project overview, structure, and commands.

## Claude-Specific

- **When starting a new feature**, check the current branch and its PR status with `gh pr view --json state,mergedAt`. If the branch was already merged, switch to `main` and run `git pull` before creating a new branch.
- **Always run `npm run build` before pushing** to regenerate `dist/`.
- Run `npm run all` (lint + test + build) before declaring work complete.
- Tests live in `__tests__/` and mirror the `src/` file structure.
- The bundled config (`config/teams.yml`) is a placeholder. Real config lives in an external repo loaded at runtime.
