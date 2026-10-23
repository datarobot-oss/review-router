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
    types: [labeled, opened, closed, ready_for_review]
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created]
  issue_comment:
    types: [created]
  schedule:
    - cron: "0 3,9,15,21 * * 1-5"

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

The action handles these event types:

- **`pull_request_target: labeled`** -- routes review when "Ready for Review" is added; when a person adds a "Needs Review: {team}" label, notifies only that team
- **`pull_request_target: opened`** -- triggers dependabot auto-labeling when enabled in config
- **`pull_request_target: closed`** -- cleans up review labels and adds Slack reactions on merge/close
- **`pull_request_review: submitted`** -- removes team labels on approval
- **`pull_request_review_comment: created`** -- notifies PR author in Slack thread on inline review comments
- **`issue_comment: created`** -- when a contributor comments `/review` on a PR, adds the "Ready for Review" label (with a rocket reaction) which triggers routing; also notifies PR author in Slack thread on general PR comments
- **`schedule`** -- reconciles open fork PRs (label removal on approval, the `approved` reaction, the Review Router check, and Slack DMs for new approvals and comments), refreshes the Review Router check on the latest commit of every open PR, then sends stale PR reminders when enabled

Uses `pull_request_target` so fork PRs work -- the workflow always runs from the base
branch, so external contributors cannot modify it or access secrets.

Routing runs once when the "Ready for Review" label is added. The label stays
on the PR after routing. To re-route (e.g. after the file list changes
significantly), remove the label and re-add it, or have a contributor comment
`/review` again after a maintainer removes the label.

## Inputs

| Input                      | Required | Default               | Description                                                                                                                                                                                                         |
| -------------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`             | Yes      | `${{ github.token }}` | GitHub token for API calls. Use a GitHub App installation token for full functionality.                                                                                                                             |
| `slack-token`              | No       | —                     | Slack Bot token for sending notifications.                                                                                                                                                                          |
| `jira-token`               | No       | —                     | Jira scoped API token for fetching ticket titles. Pass the raw token value (Bearer auth via the `api.atlassian.com` gateway; cloud ID resolved from `base_url`). Without it, Jira comments show the ticket ID only. |
| `config-repo`              | No       | —                     | Fetch teams config from a GitHub repo (e.g. `acme-inc/.review-router`). Reads `config.yml` from the repo root.                                                                                                      |
| `config-token`             | No       | —                     | GitHub token for reading the config repo. Use when the config repo is in a different org. Falls back to `github-token`.                                                                                             |
| `config-path`              | No       | `config.yml`          | Filename to look for in the config repo. Use if your config file has a different name.                                                                                                                              |
| `config-s3`                | No       | —                     | Fetch teams config from S3 (e.g. `s3://bucket/path/config.yml`). Requires AWS credentials in the environment.                                                                                                       |
| `ready-label`              | No       | `Ready for Review`    | Label name that triggers review routing.                                                                                                                                                                            |
| `needs-review-prefix`      | No       | `Needs Review`        | Prefix for per-team review labels (e.g. "Needs Review: Platform").                                                                                                                                                  |
| `needs-review-label-color` | No       | `fbca04`              | Hex color for auto-created "Needs Review" labels.                                                                                                                                                                   |

Config priority: `config-repo` > `config-s3` > bundled `config/config.yml`.

## Feature Flags

Optional features can be enabled per-org in `config.yml`:

```yaml
orgs:
  my-org:
    reminders:
      enabled: true
      stale_hours: 24 # optional, default 24
    notifications:
      dm:
        enabled: true # optional, default true
    dependabot:
      auto_label: true
    jira:
      enabled: true
      base_url: "https://acme.atlassian.net"
    teams:
      # ...
```

### Dependabot Auto-Label

When `dependabot.auto_label` is `true`, PRs opened by `dependabot[bot]` automatically
get the "Ready for Review" label, triggering the normal routing flow.

Add `opened` to the trigger types in your workflow:

```yaml
on:
  pull_request_target:
    types: [labeled, opened, closed]
```

Repos that don't want dependabot auto-labeling can simply omit `opened` from
their trigger types. The org-level config flag is a second layer of control.

### External Contributors

When `external_contributors.auto_label` is `true`, PRs from forks by people without write access get the `external-contribution` label. Non-draft PRs also get the "Ready for Review" label right away. Draft PRs get it when the author marks them ready, which needs the `ready_for_review` trigger type:

```yaml
on:
  pull_request_target:
    types: [labeled, opened, closed, ready_for_review]
```

Set `external_contributors.message` to post a welcome comment on those PRs.

### Jira Ticket Links

When `jira.enabled` is `true` and a PR title contains a bracketed ticket ID
(e.g. `[PROJ-6000] Add proxy route`), review-router posts a PR comment linking
to `{base_url}/browse/{TICKET-ID}`. Multiple bracketed IDs in one title each
get their own line.

Set the `jira-token` input to also show ticket titles instead of bare IDs.
Use a scoped API token created at id.atlassian.com with a read scope
(`read:jira-work`), and pass the raw token value (e.g. `ATSTT3xFfGF0...`).
review-router sends it as a Bearer token against the `api.atlassian.com`
gateway and resolves the cloud ID automatically from `base_url`. Classic
`email:api_token` tokens are not supported. Without a token, links still work,
just without the title.

### Stale PR Reminders

When `reminders.enabled` is `true`, a scheduled run scans open PRs that still
have the "Ready for Review" label and any "Needs Review" team labels, then
re-sends Slack notifications. Only PRs where the "Ready for Review" label was
added at least `stale_hours` (default 24) ago are reminded.

Add a `schedule` trigger to your workflow:

```yaml
on:
  schedule:
    - cron: "0 9 * * 1-5" # weekdays at 9 AM UTC
  pull_request_target:
    types: [labeled, closed]
  # ...
```

### Slack DMs

When someone approves or comments on a PR, the PR author receives a Slack direct message from the bot. Assignees receive one for comments. DMs need the `users` mapping in the config, the `chat:write` scope, and the Messages tab enabled on the Slack app's App Home page.

DMs are on by default. Set `notifications.dm.enabled: false` to turn them off for an org. When DMs are off or a DM fails, the person receives the Slack thread notification instead. To stop DMs for yourself, mute the bot's conversation in Slack.

### Review Router check

The action reports pending team approvals as a check named "Review Router" on the PR head commit. The check shows as running while teams still need to approve and completes when the last team label is removed. The check is informational. A push creates a commit without the check until the next review-router run.

The check needs the GitHub App permission **Checks**: Read and write. Without it, the action skips the check.

### Thread Notifications

When someone comments on or approves a PR that was routed by review-router,
the PR author receives an @-mention in the Slack thread of the original
notification, unless a DM was sent instead. This requires the `users` mapping in the config.

**Fork PRs are reconciled on a schedule.** GitHub withholds secrets from
`pull_request_review`, `pull_request_review_comment`, and `issue_comment`
runs whenever they're tied to a PR from a fork, regardless of the author's
org membership, so review-router can't react to those events in real time.
Instead, each `schedule` run scans open fork PRs. It removes team labels for
current approvals, adds the `approved` reaction, updates the Review Router
check, and sends DMs for approvals and comments that arrived since the
previous run. Fork PRs in a repo without a `schedule` trigger get none of
this. For every open PR, the run also rewrites the check on the latest commit, because a
push leaves the new commit without one and a removed label leaves a running one. The first run on a PR sets a cursor in the PR description and doesn't
replay earlier events. Routing, labels and the file-type/merged/closed
reactions run on `pull_request_target` and work in real time. See
[troubleshooting.md](docs/setup/troubleshooting.md#fork-prs-get-mergedfile-type-reactions-but-never-an-approval-reaction-or-thread-reply)
for details.

Add these trigger types to your workflow:

```yaml
on:
  pull_request_target:
    types: [labeled, opened, closed]
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created]
  issue_comment:
    types: [created]
```

Thread notifications are filtered automatically:

- Bot comments are ignored
- The PR author's own comments don't trigger notifications
- Review-router's own comments are skipped

**Muting:** Add a `:mute:` or `:no_bell:` reaction to the Slack message to
suppress thread notifications for that PR. DMs ignore this reaction. Mute the
bot's conversation in Slack to stop DMs.

**Note:** The PR author must be a member of the Slack channel to receive
@-mention notifications. This is a Slack limitation for private channels.

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
- [Dependabot auto-merge](docs/setup/auto-merge.md): automatically merge approved dependabot PRs
- [Troubleshooting](docs/setup/troubleshooting.md): common issues and fixes

## Adding a new team

1. Create the GitHub team in your GitHub organization
2. Add the team to repos' `.github/CODEOWNERS` files
3. Add an entry to `config/config.yml` (bundled or external)
4. Invite the Slack bot to the team's channel

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
