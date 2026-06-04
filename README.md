# Review Router

A GitHub Action that automates code review routing based on CODEOWNERS for DataRobot open-source repositories.

When the **"Ready for Review"** label is added to a PR, this action:

1. Reads `.github/CODEOWNERS` from the base branch
2. Maps changed files to owning teams
3. Applies "Needs Review: {team}" labels
4. Requests reviews from the owning teams
5. Posts a summary comment listing file ownership
6. Sends Slack notifications to team channels
7. Auto-removes labels when a team member approves

## Setup

Add two workflow files to your repo:

### Review routing — `.github/workflows/review-router.yml`

Uses `pull_request_target` so that fork PRs can be routed (the workflow always runs
from the base branch, so external contributors cannot modify it or access secrets).

```yaml
---
name: Review Router

on:
  pull_request_target:
    types: [labeled]
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  pull-requests: write

jobs:
  route:
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

### Comment trigger — `.github/workflows/review-router-comment.yml`

Lets contributors (including external fork authors who cannot add labels) type
`/review` in a PR comment to request a review. This adds the "Ready for Review"
label, which triggers the main workflow above.

```yaml
---
name: Review Router — Comment Trigger

on:
  issue_comment:
    types: [created]

permissions:
  pull-requests: write

jobs:
  trigger:
    if: >-
      github.event.issue.pull_request
      && github.event.comment.body == '/review'
    runs-on: ubuntu-latest
    steps:
      - name: Add Ready for Review label
        uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.addLabels({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              labels: ['Ready for Review']
            });
            await github.rest.reactions.createForIssueComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              comment_id: context.payload.comment.id,
              content: 'rocket'
            });
```

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
* @datarobot/applications

# Infrastructure
infra/ @datarobot/platform-team
```

## Adding a new team

1. Create the GitHub team in the your GitHub organization
2. Add the team to repos' `.github/CODEOWNERS` files
3. Add an entry to `config/teams.yml` in this [review-router](https://github.com/datarobot-oss/review-router)
4. Invite the Slack bot to the team's channel

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
