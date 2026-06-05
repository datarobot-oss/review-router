# Basic Setup

This guide walks through setting up review-router in a single repository.
By the end, PRs labeled "Ready for Review" will be automatically routed
to the right teams based on your CODEOWNERS file.

## Prerequisites

- A GitHub organization with at least one team
- Admin access to the target repository
- A GitHub App (recommended) or a Personal Access Token

## 1. Create a GitHub App

The action works best with a GitHub App installation token. This gives it
the permissions it needs without using a personal account.

1. Go to your org settings > Developer settings > GitHub Apps > New GitHub App
2. Set the following permissions:
   - **Contents**: Read
   - **Issues**: Write
   - **Members**: Read
   - **Metadata**: Read
   - **Pull requests**: Write
3. Install the app on your organization
4. Note the **App ID** and generate a **Private Key**

If you prefer, you can use a fine-grained PAT with the same permissions
instead of a GitHub App.

## 2. Add repository secrets

Go to your repo's Settings > Secrets and variables > Actions, and add:

| Secret name | Value |
|-------------|-------|
| `REVIEW_ROUTER_APP_ID` | The GitHub App ID |
| `REVIEW_ROUTER_APP_PRIVATE_KEY` | The GitHub App private key (PEM file contents) |
| `SLACK_BOT_TOKEN` | (Optional) Slack Bot OAuth token for notifications |

## 3. Add CODEOWNERS

Create `.github/CODEOWNERS` in your repository. Each line maps a file
pattern to the team that owns it:

```
# Default owner for everything
* @your-org/core-team

# Frontend
src/components/ @your-org/frontend

# Infrastructure
infra/ @your-org/platform
terraform/ @your-org/platform

# Documentation
docs/ @your-org/docs-team
```

The team slugs here (e.g. `core-team`, `frontend`) must match the GitHub
team names in your organization.

## 4. Add the workflow

Create `.github/workflows/review-router.yml`:

```yaml
name: Review Router

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

### What each trigger does

- `pull_request_target: labeled` runs the review routing when someone
  adds the "Ready for Review" label to a PR.
- `pull_request_review: submitted` removes team labels when a team
  member approves the PR.
- `issue_comment: created` lets contributors type `/review` on a PR
  to trigger routing (useful for fork contributors who cannot add labels).

The `if` condition skips the runner for comments that don't contain
`/review`. The action itself does a strict exact match on the comment body.

### Why `pull_request_target`?

Using `pull_request_target` instead of `pull_request` means the workflow
runs from the base branch (your main), not the PR branch. This is
important because:

- Fork PRs get access to secrets (the workflow code is trusted)
- External contributors cannot modify the workflow or access secret values
- The action never checks out code, so there is no risk of running
  untrusted code from a fork

## 5. Configure team labels (optional)

By default, the action generates labels like "Needs Review: Core Team"
from the CODEOWNERS team slug. To customize labels or add Slack channels,
edit `config/teams.yml` in the review-router repository:

```yaml
orgs:
  your-org:
    teams:
      core-team:
        label: "Needs Review: Core"
        slack_channel: "C01ABC123"
      frontend:
        label: "Needs Review: Frontend"
        slack_channel: "C02DEF456"
```

If a team is not in the config, it still gets routed with an
auto-generated label.

## 6. Verify the setup

1. Create a test PR with a file change
2. Add the "Ready for Review" label
3. Check that:
   - The correct "Needs Review: {team}" label(s) appear
   - A comment is posted listing file ownership
   - (If Slack is configured) A notification is sent to the team channel
4. Approve the PR and verify the "Needs Review" label is removed

## Using /review command

Contributors who cannot add labels (e.g. fork PR authors) can type
`/review` as a comment on their PR. The action will:

1. Add the "Ready for Review" label
2. React to the comment with a rocket emoji
3. Routing triggers automatically from the label

The comment body must be exactly `/review` (whitespace is trimmed).
Bot comments are ignored.
