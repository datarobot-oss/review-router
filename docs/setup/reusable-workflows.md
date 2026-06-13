# Reusable Workflows

If you manage multiple repositories in an organization, you can centralize
the review-router setup using GitHub's reusable workflows. This means
downstream repos need a single minimal workflow file with no secrets.

## How it works

1. A **reusable workflow** in your org's `.github` repo handles token
   generation, secrets, and the review-router call
2. Each **downstream repo** has a slim caller workflow that forwards
   events to the reusable workflow
3. Secrets are stored once (on the `.github` repo) and shared via
   `secrets: inherit`

## Setting up the reusable workflow

### 1. Create the `.github` repo

If your org doesn't already have one, create a repo called `.github`.
This is a special repo that GitHub uses for org-wide defaults.

### 2. Add secrets to the `.github` repo

Go to the `.github` repo's Settings > Secrets and variables > Actions:

| Secret name | Value |
|-------------|-------|
| `REVIEW_ROUTER_APP_ID` | The GitHub App ID |
| `REVIEW_ROUTER_APP_PRIVATE_KEY` | The GitHub App private key |
| `SLACK_BOT_TOKEN` | Slack Bot OAuth token |

### 3. Add the reusable workflow

Create `.github/workflows/review-router.yml` in the `.github` repo:

```yaml
name: Review Router

on:
  workflow_call:

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

### With external config (cross-org)

If your config repo is in a different org, add a second token step:

```yaml
name: Review Router

on:
  workflow_call:

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

      - name: Generate config repo token
        id: config-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.REVIEW_ROUTER_APP_ID }}
          private-key: ${{ secrets.REVIEW_ROUTER_APP_PRIVATE_KEY }}
          owner: config-org
          repositories: .review-router

      - name: Run Review Router
        uses: datarobot-oss/review-router@v1
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          config-token: ${{ steps.config-token.outputs.token }}
          config-repo: config-org/.review-router
          slack-token: ${{ secrets.SLACK_BOT_TOKEN }}
```

## Setting up downstream repos

Each repo that wants review routing adds a single workflow file.

Create `.github/workflows/review-router.yml`:

```yaml
name: Review Router

on:
  pull_request_target:
    types: [labeled, opened, closed]
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created]
  issue_comment:
    types: [created]

jobs:
  route:
    uses: your-org/.github/.github/workflows/review-router.yml@main
    secrets: inherit
```

That's it. No secrets, no token generation, no action version pinning.

## Multi-org setup

If you have repos across multiple GitHub organizations, each org needs
its own `.github` repo with its own secrets. The reusable workflow file
is identical, only the secrets and org name differ.

For example, with `org-a` and `org-b`:

- `org-a/.github` has its own secrets and reusable workflow
- `org-b/.github` has its own secrets and reusable workflow
- Both can point to the same config repo (using `config-token`)
- Downstream repos in `org-a` call `org-a/.github/.github/workflows/...`
- Downstream repos in `org-b` call `org-b/.github/.github/workflows/...`

## Requirements

- The `.github` repo must be **public** for reusable workflows to work
  across the org. This is a GitHub requirement.
- Secret names are visible in the public workflow file, but secret values
  are stored in GitHub's encrypted secrets store and never exposed.
- The GitHub App must be installed on the org for token generation
  to work.

## Updating the action version

When you want to update review-router, change the version pin in the
reusable workflow:

```yaml
# In the .github repo's reusable workflow
uses: datarobot-oss/review-router@v1
```

All downstream repos pick up the change immediately. No per-repo PRs
needed.
