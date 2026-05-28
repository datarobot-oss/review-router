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

Add this workflow to your repo at `.github/workflows/review-router.yml`:

### Full mode (with GitHub App)

```yaml
---
name: Review Router

on:
  pull_request:
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

### PoC mode (no GitHub App needed)

```yaml
---
name: Review Router

on:
  pull_request:
    types: [labeled]

permissions:
  contents: read
  pull-requests: write

jobs:
  route:
    runs-on: ubuntu-latest
    steps:
      - uses: datarobot-oss/review-router@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

PoC limitations: no team review requests, no auto-label removal on approval, no Slack.

## CODEOWNERS

Add a `.github/CODEOWNERS` file to your repo:

```
# Default
* @datarobot/applications

# Infrastructure
infra/ @datarobot/platform-team
```

## Adding a new team

1. Create the GitHub team in the appropriate org
2. Add the team to repos' `.github/CODEOWNERS` files
3. Add an entry to `config/teams.yml` in this repo
4. Invite the Slack bot to the team's channel

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
