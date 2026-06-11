# Review Router

A GitHub Action that automates code review routing based on CODEOWNERS for DataRobot open-source repositories.

GitHub App: https://github.com/apps/datarobot-pr-review-router

When the **"Ready for Review"** label is added to a PR, this action:

1. Reads `.github/CODEOWNERS` from the base branch
2. Maps changed files to owning teams
3. Applies "Needs Review: {team}" labels
4. Requests reviews from the owning teams
5. Posts a summary comment listing file ownership
6. Sends Slack notifications to team channels
7. Auto-removes labels when a team member approves

## Setup

Add a single workflow to your repo at `.github/workflows/review-router.yml`:

```yaml
---
name: Review Router

# SECURITY: This workflow intentionally uses pull_request_target (not
# pull_request) because review-router never checks out or executes PR code.
# Do NOT add actions/checkout or shell run: blocks here.
#
# If you need to build or test PR code, use a separate workflow with the
# pull_request trigger instead.
#
# See: https://github.com/datarobot-oss/review-router/blob/main/docs/security/pull-request-target.md

on:
  pull_request_target:
    types: [labeled]
  pull_request_review:
    types: [submitted]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  route:
    if: >-
      github.event_name != 'issue_comment'
      || contains(github.event.comment.body, '/review')
    runs-on: ubuntu-latest
    steps:
      - name: Generate GitHub App token
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.REVIEW_ROUTER_APP_ID }}
          private-key: ${{ secrets.REVIEW_ROUTER_APP_PRIVATE_KEY }}

      - name: Run Review Router
        uses: datarobot-oss/review-router@v1
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          slack-token: ${{ secrets.SLACK_BOT_TOKEN }}
```

The action handles three event types:
- **`pull_request_target: labeled`** — routes review when "Ready for Review" is added
- **`pull_request_review: submitted`** — removes team labels on approval
- **`issue_comment: created`** — when a contributor comments `/review` on a PR, adds the "Ready for Review" label (with a rocket reaction) which triggers routing

Uses `pull_request_target` so fork PRs work — the workflow always runs from the base
branch, so external contributors cannot modify it or access secrets.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | Yes | `${{ github.token }}` | GitHub token for API calls. Use a GitHub App installation token for full functionality. |
| `slack-token` | No | — | Slack Bot token for sending notifications. |
| `config-repo` | No | — | Fetch teams config from a GitHub repo (e.g. `datarobot/.review-router`). Reads `teams.yml` from the repo root. |
| `config-s3` | No | — | Fetch teams config from S3 (e.g. `s3://bucket/path/teams.yml`). Requires AWS credentials in the environment. |
| `ready-label` | No | `Ready for Review` | Label name that triggers review routing. |
| `needs-review-prefix` | No | `Needs Review` | Prefix for per-team review labels (e.g. "Needs Review: Platform"). |
| `needs-review-label-color` | No | `fbca04` | Hex color for auto-created "Needs Review" labels. |

Config priority: `config-repo` > `config-s3` > bundled `config/teams.yml`.

## CODEOWNERS

Add a `.github/CODEOWNERS` file to your repo:

```
# Default
* @acme-copr/core-team

# Infrastructure
infra/ @acme-corp/infra-team
```

## Guides

- [Basic setup](docs/setup/basic.md): single-repo setup with step-by-step instructions
- [External config](docs/setup/external-config.md): store team config in a GitHub repo or S3
- [Reusable workflows](docs/setup/reusable-workflows.md): centralize the setup for an entire org
- [Troubleshooting](docs/setup/troubleshooting.md): common issues and fixes

## Adding a new team

1. Create the GitHub team in your GitHub organization
2. Add the team to repos' `.github/CODEOWNERS` files
3. Add an entry to `config/teams.yml` (bundled or external)
4. Invite the Slack bot to the team's channel

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
