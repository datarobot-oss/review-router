# External Configuration

By default, review-router uses a bundled `config/teams.yml` for team
labels and Slack channels. For organizations that want to manage config
separately (e.g. in a private repo or S3 bucket), the action supports
two external config sources.

Config priority: `config-repo` > `config-s3` > bundled `config/teams.yml`.

If the external config cannot be fetched or parsed, the action falls back
to the bundled config and logs a warning.

## Config file format

Whether bundled, in a repo, or on S3, the config file is always `teams.yml`
with this structure:

```yaml
orgs:
  your-org:
    default_slack_channel: "C00DEFAULT"
    teams:
      core-team:
        label: "Needs Review: Core"
        slack_channel: "C01ABC123"
      frontend:
        label: "Needs Review: Frontend"
        slack_channel: "C02DEF456"

  another-org:
    teams:
      backend:
        label: "Needs Review: Backend"
        slack_channel: "C03GHI789"

users:
  johndoe: U01ABC123
  janedoe: U02DEF456
```

### Required fields

Each team must have:
- `label`: the GitHub label applied to the PR
- `slack_channel`: Slack channel ID for notifications (empty string to skip)

Optional fields:
- `default_slack_channel`: fallback channel when a team has no channel set
- `users`: GitHub username to Slack user ID mapping

The config is validated at runtime against
[config/schema.json](../../config/schema.json). Invalid config is rejected
with a descriptive error.

## Option A: GitHub repository

Store `teams.yml` in a GitHub repository. This gives you version control,
PR reviews for config changes, and access control via GitHub permissions.

### Setup

1. Create a repository for the config (e.g. `your-org/.review-router`)
2. Add a `teams.yml` file at the root of the repo
3. Make sure the GitHub App is installed on the repo (or the org that
   contains it)

### Workflow configuration

```yaml
- name: Run Review Router
  uses: datarobot-oss/review-router@v1
  with:
    github-token: ${{ steps.app-token.outputs.token }}
    config-repo: your-org/.review-router
    slack-token: ${{ secrets.SLACK_BOT_TOKEN }}
```

The action fetches `teams.yml` from the repo's default branch
(auto-detected, not hardcoded to `main`).

### Cross-org config repo

If the config repo is in a different org than the repo being routed,
the `github-token` won't have access to it. Use `config-token` to
provide a separate token:

```yaml
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
    owner: other-org
    repositories: .review-router

- name: Run Review Router
  uses: datarobot-oss/review-router@v1
  with:
    github-token: ${{ steps.app-token.outputs.token }}
    config-token: ${{ steps.config-token.outputs.token }}
    config-repo: other-org/.review-router
    slack-token: ${{ secrets.SLACK_BOT_TOKEN }}
```

This requires the GitHub App to be installed on both orgs.

## Option B: S3

Store `teams.yml` in an S3 bucket. Useful when you already have
infrastructure for managing config files via S3, or when you need
config access from environments that don't have GitHub API access.

### Setup

1. Upload your `teams.yml` to an S3 bucket
2. Set up AWS credentials in your workflow (IAM role or access keys)
3. The S3 object needs `s3:GetObject` permission for the workflow's
   AWS identity

### Workflow configuration

```yaml
- name: Configure AWS credentials
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789012:role/review-router
    aws-region: us-east-1

- name: Run Review Router
  uses: datarobot-oss/review-router@v1
  with:
    github-token: ${{ steps.app-token.outputs.token }}
    config-s3: s3://my-bucket/review-router/teams.yml
    slack-token: ${{ secrets.SLACK_BOT_TOKEN }}
```

The action uses the AWS SDK with ambient credentials from the environment.
Any authentication method supported by `aws-actions/configure-aws-credentials`
works (OIDC, access keys, etc.).

## Validating config changes

The config is validated against a JSON Schema at
[config/schema.json](../../config/schema.json). You can use this schema
in CI to catch errors before they reach production.

Example validation step for a config repo:

```yaml
# In the config repo's CI workflow
- name: Validate teams.yml
  run: |
    npm install ajv-cli
    npx ajv validate \
      -s https://raw.githubusercontent.com/datarobot-oss/review-router/main/config/schema.json \
      -d teams.yml \
      --spec=draft7
```

## Switching from bundled to external config

1. Copy the current `config/teams.yml` to your config repo or S3 bucket
2. Add `config-repo` or `config-s3` to your workflow
3. Test on a single repo first
4. Roll out to remaining repos
5. The bundled config remains as a fallback if the external source
   is unreachable
