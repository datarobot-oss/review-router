# AI review guidance for review-router

This action runs on `pull_request_target`, so it holds secrets while it handles PRs from anyone. Weigh these first:

- Anything that checks out, builds, runs, or evaluates PR content, or that hands a token to a child process or a model session.
- A failure in an optional feature (Slack, Jira, reminders, the AI review) that can fail the whole job. Those paths catch errors and log a warning instead.
- GitHub list calls that can return more than one page but don't paginate.
- A config change that touches `src/types.ts` or `config/schema.json` without the other. External configs are validated against the schema at runtime.

Skip `dist/`, which is generated, and `package-lock.json`.
