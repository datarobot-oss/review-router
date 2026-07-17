# Security: pull_request_target usage in review-router

## Background

The review-router workflow uses `pull_request_target` instead of `pull_request`
so that fork PRs have access to secrets (GitHub App credentials, Slack token).
This is necessary because `pull_request` from forks runs with read-only
permissions and no secret access.

The `pull_request_target` trigger has a well-documented attack surface when
misused. This document explains why review-router's usage is safe.

## The known attack pattern

All known `pull_request_target` exploits follow the same pattern:

1. Workflow uses `pull_request_target` (has write permissions and secret access)
2. Workflow checks out **the PR branch** code (`actions/checkout` with
   `ref: ${{ github.event.pull_request.head.sha }}`)
3. Workflow **executes** that code (build scripts, linters, tests)
4. Attacker's code runs with access to secrets and write permissions

References:

- https://github.com/eigent-ai/eigent/security/advisories/GHSA-gvh4-93cq-5xxp
- https://securitylab.github.com/research/github-actions-preventing-pwn-requests/
- https://orca.security/resources/blog/pull-request-nightmare-part-2-exploits/

The fix in the eigent case (https://github.com/eigent-ai/eigent/pull/837)
was not to remove `pull_request_target`, but to stop checking out and executing
PR code in that workflow. Operations that need PR code were moved to a
separate `pull_request` workflow with read-only permissions.

## Why review-router is not vulnerable

### No PR code is checked out or executed

The downstream caller workflow:

```yaml
jobs:
  route:
    if: >-
      github.event_name != 'issue_comment'
      || contains(github.event.comment.body, '/review')
    uses: your-org/.github/.github/workflows/review-router.yml@main
    secrets: inherit
```

The reusable workflow generates app tokens and calls the review-router action.
There is no `actions/checkout` step. There are no shell `run:` blocks. No PR
code is ever fetched, checked out, or executed.

### Workflow source is always the base branch

All three triggers read the workflow YAML from the base/default branch, never
from the PR branch:

| Trigger               | Workflow source |
| --------------------- | --------------- |
| `pull_request_target` | base branch     |
| `pull_request_review` | default branch  |
| `issue_comment`       | default branch  |

An attacker who modifies `.github/workflows/review-router.yml` in their fork
gains nothing -- that modified file is never executed.

### Secrets availability is not the same as workflow source

The table above is about which workflow _file_ runs, not whether that run
has secrets. GitHub applies its fork-PR secret restriction (normally
associated with `pull_request`) to `pull_request_review`,
`pull_request_review_comment`, and `issue_comment` runs as well, whenever
they're tied to a PR whose head branch is in a fork -- regardless of the PR
author's org or repo permissions. Confirmed empirically: these runs show
`Secret source: None` and a read-only token in the setup logs, and the
action exits immediately with `No github-token provided -- skipping`.

`pull_request_target` is unaffected by this -- it always runs with full
secrets, fork or not, which is the whole reason review-router uses it for
opened/labeled/closed. But `handleReviewSubmitted` (approval reactions,
label removal on approval) and `handleComment` (Slack thread replies) run
on the other three event types, so neither ever fires for a fork-originated
PR. There is no workflow configuration that restores secrets to these event
types on fork PRs -- it's a hard platform boundary. See
[troubleshooting.md](../setup/troubleshooting.md#fork-prs-get-mergedfile-type-reactions-but-never-an-approval-reaction-or-thread-reply)
for the symptom and confirmation steps.

### No expression injection surface

The only user-controlled value in a workflow expression is the comment body:

```yaml
if: >-
  github.event_name != 'issue_comment'
  || contains(github.event.comment.body, '/review')
```

This is evaluated by the GitHub Actions expression engine, not in a shell.
There are no `run:` blocks that interpolate `github.event.*` values, so there
is no script injection risk.

### The action only reads metadata, not code

The review-router action:

- Reads CODEOWNERS from the **base branch** (not the PR branch)
- Reads the list of changed filenames (not file contents)
- Posts labels, comments, and Slack messages
- Never checks out, builds, or runs any repository code

### Credentials are short-lived and scoped

- GitHub App tokens are generated per-run and expire in 1 hour
- The app token is scoped to the permissions configured in the app
  (Contents: Read, Pull requests: Write, Members: Read, Issues: Write)
- The config token (when used) is scoped to a single config repository
- Slack token can only post messages to channels the bot is in

### Supply chain protections on review-router

The `datarobot-oss/review-router` repo (the `@v1` tag source) is hardened:

- Merging requires maintainer approval
- Signed commits required
- Force pushes denied
- No external write access

This prevents an attacker from tampering with the action code that receives
the tokens.

## What would make pull_request_target unsafe

Adding any of the following to the workflow would introduce the vulnerability:

- `actions/checkout` with the PR ref
- A shell `run:` block that interpolates `github.event.*` values
- Any step that fetches and executes code from the PR branch

If any of these are ever needed, they must go in a separate `pull_request`
workflow with read-only permissions and no secret access.
