# Review Router gate

The gate is a required status check named `Review Router gate`. It replaces GitHub's required approvals on a branch ruleset, so a repository can merge trusted automation, such as Dependabot, without a person and still require one approval for everything else.

## How the gate decides

The gate posts one result per pull request head commit. The result is `success` or `action_required`. Both `neutral` and `skipped` satisfy a required check, so the gate never posts them.

The gate checks these rules in order:

1. A person with write access whose latest review requests changes blocks the pull request.
2. A person approves the pull request when all of these hold:
   - The reviewer has write or admin access and is a user, not an App or a bot.
   - The review is on the current head commit.
   - The reviewer is not the author and did not author or commit any commit in the pull request.
3. A policy family passes the pull request without a review when every rule of the family holds.
4. Otherwise the pull request waits for a person.

An error while reading the pull request posts `action_required` with the reason, so the gate fails closed.

### Dependabot family

The family passes a pull request when all of these hold:

- The author is `dependabot[bot]`, and the branch is a `dependabot/` branch of the same repository.
- Every commit has the author `dependabot[bot]`, the committer `web-flow`, and a verified signature.
- No changed file is under `.github/`.
- Every changed file, including the previous name of a renamed file, matches `allowed_paths`.
- The pull request changes at most `max_changed_files` files.
- Every commit states an `update-type` in its Dependabot metadata, and each type is in `update_types`.

A person who pushes a commit to the Dependabot branch, or updates it with a merge commit, moves the pull request to the approval rule.

## Enable the gate

A repository joins the gate when its default branch holds `.github/review-router.yml`, or when a ruleset on the default branch requires `Review Router gate`. The gate reads the policy from the default branch only, so a pull request can't change the rules it is judged by.

Create `.github/review-router.yml` on the default branch:

```yaml
dependabot:
  allowed_paths:
    - requirements/**
    - Dockerfile
  max_changed_files: 10
  update_types: [patch, minor]
```

| Key | Default | Description |
|-----|---------|-------------|
| `allowed_paths` | none | Glob patterns for the files the family may change. `*` stays in one directory, `**` spans directories. An empty list turns the family off. |
| `max_changed_files` | `10` | Largest number of changed files. |
| `update_types` | `[patch, minor]` | Update types the family passes. Values are `patch`, `minor`, `major`. |

A policy file with an error leaves the repository in the gate with no family. Approvals by a person still pass.

### Update the caller workflow

The gate runs inside the Review Router workflow. Add these triggers to the caller workflow of the repository:

```yaml
on:
  pull_request_target:
    types: [labeled, opened, closed, ready_for_review, synchronize, reopened, edited]
  pull_request_review:
    types: [submitted, dismissed, edited]
  merge_group:
    types: [checks_requested]
  schedule:
    - cron: "*/30 * * * *"
```

`synchronize` posts the result on a new head commit. `merge_group` posts the result on the commit of a merge queue entry. `schedule` re-evaluates every open pull request and fixes a result that no event updated.

## Require the gate

Report first. With the policy file in place and no ruleset change, the gate posts results and blocks nothing. Check the results on a few pull requests, then edit the ruleset of the default branch in one change:

1. Set required approvals to `0` and turn off code owner review.
2. Add `Review Router gate` to the required status checks, pinned to the Review Router GitHub App.

To roll back, restore the required approvals and remove the check from the ruleset. The gate keeps posting and blocks nothing.

## Limits

- The gate is as strong as write access to the repository. The Review Router key is an organization secret that a workflow in the repository can read, so a person who can push a workflow can mint a token and post a passing result. Treat write access as the trust boundary until the gate runs under its own GitHub App.
- The gate does not post `in_progress`. A pull request shows no result between a push and the next run.
- A review on a pull request from a fork starts no run with secrets, so the scheduled run posts the new result.
- A pull request with more than 250 commits or 3000 changed files fails closed.
