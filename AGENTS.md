# Review Router

GitHub Action that routes code reviews based on CODEOWNERS. TypeScript, bundled with ncc.

## Commands

```bash
npm run lint          # ESLint on src/ and __tests__/
npm test              # Jest with coverage
npm run build         # ncc bundle to dist/
npm run all           # lint + test + build
```

## Project Structure

- `src/` -- action source code (TypeScript)
  - `index.ts` -- entry point, event dispatch
  - `router.ts` -- label/review/Slack routing logic
  - `codeowners.ts` -- CODEOWNERS parsing, file-to-team mapping
  - `config.ts` -- team config loading (bundled, GitHub repo, S3)
  - `comment.ts` -- PR comment builder
  - `labels.ts` -- GitHub label operations
  - `slack.ts` -- Slack notifications
  - `auth.ts` -- capability detection
  - `types.ts` -- shared interfaces
- `__tests__/` -- Jest tests (mirrors src/ structure)
- `config/` -- bundled team config (`config.yml`) and JSON Schema (`schema.json`)
- `dist/` -- ncc output (committed, required by GitHub Actions)
- `docs/` -- setup guides and security docs
- `action.yml` -- GitHub Action definition

## Development

- TypeScript strict mode, ES2022 target
- ESLint with TypeScript recommended rules
- Jest with ts-jest, coverage collected from `src/**/*.ts` (excluding `src/index.ts`)
- `dist/` must be rebuilt before pushing (`npm run build`). CI auto-commits it on PRs, but include it in your commit.

## Release

- The `v1` floating tag is updated automatically on push to main via `release.yml`
- Version is read from `package.json`
- No manual retagging needed

## Architecture

The action handles three GitHub event types:

1. **`pull_request_target: labeled`** -- parses CODEOWNERS from the base branch, maps changed files to teams, applies "Needs Review: {team}" labels, requests team reviews, posts ownership comment, sends Slack notifications
2. **`pull_request_review: submitted`** -- removes team labels when a member of that team approves
3. **`issue_comment: created`** -- on `/review` comment, adds "Ready for Review" label to trigger routing

Config loading priority: `config-repo` > `config-s3` > bundled `config/config.yml`. External config is validated against `config/schema.json` using Ajv.

## Security

Uses `pull_request_target` intentionally -- the action never checks out or executes PR code. See `docs/security/pull-request-target.md` for the full analysis.
