# Troubleshooting

Common issues and how to fix them.

## "Input required and not supplied: app-id"

```
Error: Input required and not supplied: app-id
```

**Cause**: The `REVIEW_ROUTER_APP_ID` secret is not configured, or this
is a fork PR using `pull_request` (which doesn't pass secrets to forks).

**Fix**: Either configure the secret, or switch the workflow trigger
from `pull_request` to `pull_request_target`. See the
[basic setup guide](basic.md) for details.

## Slack notification not sent

The action logs `Failed to send Slack notification to <channel>` or
the notification simply doesn't appear.

**Common causes**:

1. **Bot not in channel**: The Slack bot must be a member of the channel
   to post messages. Invite it with `/invite @your-bot-name` in the
   Slack channel.

2. **Wrong channel ID**: Channel IDs look like `C01ABC123`. You can find
   them by right-clicking a channel in Slack > View channel details >
   the ID is at the bottom of the popup.

3. **Empty `slack-token`**: If the `SLACK_BOT_TOKEN` secret is not set,
   notifications are silently skipped. Check the workflow logs for
   "No Slack token provided, skipping notification".

4. **Duplicate notifications suppressed**: If multiple teams share the
   same Slack channel, the action sends only one notification per channel
   per PR.

## "No CODEOWNERS file found"

```
No .github/CODEOWNERS file found on the main branch
```

**Cause**: The action looks for `.github/CODEOWNERS` on the PR's base
branch (usually `main`). If the file only exists on the PR branch,
it won't be found.

**Fix**: Make sure `.github/CODEOWNERS` is merged to the base branch
before routing PRs.

## Labels created but no team review requested

The "Needs Review: Team" label appears but no team review is requested
on the PR.

**Cause**: Team review requests require the token to have org-level
team read access. The default `GITHUB_TOKEN` doesn't have this.

**Fix**: Use a GitHub App installation token or a PAT with `read:org`
scope. See the [basic setup guide](basic.md) for GitHub App setup.

## "Unowned files" in the comment

Some files show as "Unowned files (no CODEOWNERS match)" in the
ownership comment.

**Cause**: These files don't match any pattern in `.github/CODEOWNERS`,
and there is no `*` catch-all rule with a team owner.

**Fix**: Add a catch-all rule at the top of your CODEOWNERS file:

```
* @your-org/default-team
```

Files owned by individual users (e.g. `@johndoe` instead of
`@your-org/team`) are automatically assigned to the default team
if one exists.

## Config validation errors

```
Config validation failed: /orgs/your-org/teams/foo must have required property 'slack_channel'
```

**Cause**: The `teams.yml` file doesn't match the expected schema.

**Fix**: Check your config against the schema at
[config/schema.json](../../config/schema.json). Every team entry
needs both `label` and `slack_channel` (use empty string `""` to
skip notifications).

## External config not loading

The action falls back to bundled config even though `config-repo`
or `config-s3` is set.

**Possible causes**:

1. **Token lacks access**: The `github-token` can't read the config
   repo. If the config repo is in a different org, use `config-token`.
   See [external config](external-config.md).

2. **Wrong repo format**: `config-repo` must be in `owner/repo` format
   (e.g. `your-org/.review-router`).

3. **Wrong S3 URI format**: `config-s3` must be in `s3://bucket/key`
   format (e.g. `s3://my-bucket/review-router/teams.yml`).

4. **Missing org section**: The config file exists but doesn't have a
   section for the current org. The action logs a warning and falls
   back to bundled config.

5. **AWS credentials not configured**: For S3 config, make sure
   `aws-actions/configure-aws-credentials` runs before the review-router
   step.

## Workflow runs on every comment

The workflow triggers for all PR comments, not just `/review`.

**Fix**: Add the `if` filter to skip irrelevant comments before
starting a runner:

```yaml
jobs:
  route:
    if: >-
      github.event_name != 'issue_comment'
      || contains(github.event.comment.body, '/review')
```

The action also performs a strict check internally, so incorrect
triggers exit immediately without making API calls. The `if` filter
saves runner startup time.

## Fork PRs don't trigger routing

Fork PRs are opened but the review router doesn't run.

**Cause**: The workflow uses `pull_request` instead of
`pull_request_target`. With `pull_request`, fork PRs don't receive
secrets, so the token generation step fails.

**Fix**: Switch to `pull_request_target` in your workflow triggers.
This is safe because the action never checks out code from the PR
branch. See the [basic setup guide](basic.md) for the recommended
workflow configuration.
