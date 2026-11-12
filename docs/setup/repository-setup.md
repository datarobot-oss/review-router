# Set up a repository for the merge flow

This guide sets up a repository so that a Dependabot update inside a policy merges on its own, and every other pull request merges after one approval from a person who didn't write it. Nobody clicks **Merge when ready**. The steps link to the pages that hold the details.

## What the setup gives

- Dependabot updates that pass the [gate](gate.md) merge with no reviewer, no label and no reminder.
- Any other pull request waits for one approval from a person with write access who didn't author or push to it.
- A pull request that has its approvals and checks enters the [merge queue](merge-queue.md) and merges, and the queue runs the required checks again on the result.
- The Review Router routes only the pull requests that need a person.
- No Review Router key can post a result that satisfies the ruleset.

## Prerequisites

- An organization owner. The owner holds the App keys, adds the repository to the Apps, and stores the keys in the repository, so a repository administrator never receives a key file.
- A plan that offers merge queues: public repositories owned by an organization, or private repositories on GitHub Enterprise Cloud.
- A CI workflow that provides one required check that always reports. A required check that a path filter or a skipped job leaves out never reports, and the pull request waits forever. Roll the jobs up in one job that runs with `if: always()` and fails when a job that had to run didn't succeed. See [Roll up the CI check](#roll-up-the-ci-check).
- The `merge_group` trigger on every workflow that provides a required check.
- A second person with write access for the verification. A new repository gives nobody write access, so add the person as a collaborator or through a team first.

## Roll up the CI check

The required check is the name of the roll-up job. This workflow provides a required check named `ci`. List every job that must pass in `needs` and test each result in the last step:

```yaml
name: CI

on:
  pull_request:
  merge_group:
    types: [checks_requested]
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo "Run the checks of the repository here."

  ci:
    if: always()
    needs: [check]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Fail when a job did not succeed
        env:
          RESULT: ${{ needs.check.result }}
        run: test "$RESULT" = success
```

## Choose who owns the Apps

The setup needs two GitHub Apps: the Gate App that posts `Bouncer`, and the merge queue App that enqueues. An App's private key mints a token for every installation of that App, so the owner decides who can post a passing `Bouncer` or enqueue a pull request.

- **One App pair per organization.** Each organization's owners hold the keys, and a key never leaves the organization. Use this model by default.
- **One App pair for several organizations.** One team owns the Apps, installs them in the other organizations, and enrolls each repository itself, so repository administrators never receive the key file. A leaked key then forges `Bouncer` in every organization where the App is installed, and every enrolled repository holds a copy of the key as an environment secret. A person who can merge a change to the default branch of an enrolled repository can read that copy.

Install each App on selected repositories, never on all of them. A key mints tokens for every repository where its App is installed, so an installation on all repositories lets a leaked key reach repositories that never joined the flow. The merge queue key holds **Contents: write**, which pushes to any branch that no ruleset protects. Every enrolled repository holds a copy of each key as an environment secret, and the administrators of that repository keep the reach that comes with it. An organization owner adds a repository to both installations when it joins, and stores the keys in it.

## Set up the repository

1. Create the [Gate App](gate.md#create-the-gate-app) and the [merge queue App](merge-queue.md#create-the-merge-queue-app), then add the repository to both installations as an organization owner. Skip the creation when the owner already created the Apps. List the installations of the organization, then add the repository to the installation of each App:

   ```bash
   ORG=OWNER
   REPO=OWNER/REPO
   gh api "orgs/$ORG/installations?per_page=100" \
     --jq '.installations[] | [.id, .app_slug, .repository_selection] | @tsv'
   REPO_ID=$(gh api "repos/$REPO" --jq .id)
   gh api -X PUT "user/installations/INSTALLATION_ID/repositories/$REPO_ID"
   ```

   Run the last command once for each App, with its installation ID. An installation that lists `all` already covers every repository, and the command isn't needed.
2. Create the `gate` environment with its [variables and key](gate.md#store-the-key-in-an-environment), and the `merge-queue` environment with its [variable and key](merge-queue.md#store-the-key-in-an-environment). Each environment allows only the default branch.
3. Create the policy file `.github/review-router.yml` on the default branch. See [Enable the gate](gate.md#enable-the-gate).
4. Add the workflows on the default branch:
   - The Review Router workflow. See [Basic setup](basic.md).
   - `Review Router replay`, in a repository that accepts fork pull requests. It sends the DMs and label changes that a fork's skipped review run missed. See [Fork PRs](notifications.md#fork-prs).
   - `Gate trigger` and `Gate`. See [Add the workflows](gate.md#add-the-workflows).
   - `merge-queue`. See [Add the workflow](merge-queue.md#add-the-workflow).
5. Add `.github/dependabot.yml` for the ecosystems that the repository uses. The native [Dependabot auto-merge](auto-merge.md) workflow isn't needed. In a repository with a merge queue it never enqueues.
6. Set the default workflow token to read-only. Every workflow in the repository must declare its own `permissions` first:

   ```bash
   REPO=OWNER/REPO
   gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
     -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
   ```

7. Let the gate report before it blocks. Check the results on a few pull requests, then edit the ruleset of the default branch in one change. See [Check the results](gate.md#check-the-results) and [Require the gate](gate.md#require-the-gate). The edit sets all of these:
   - The rolled-up CI check is required.
   - `Bouncer` is required and pinned to the Gate App.
   - A merge queue is required.
   - Required approvals are `0` and code owner review is off.
8. In a public repository, keep the `pull_request_target` event allowed. GitHub blocks it by default in public repositories, and the Review Router and the gate run on it. An organization-level Actions policy that allows the event keeps them working. See [About Actions policies](https://docs.github.com/en/actions/concepts/about-actions-policies) and the [GitHub changelog entry](https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2) for the enforcement date.

## Verify the setup

Run the checks in order. Set `REPO` to the repository, as `OWNER/REPO`.

1. Confirm the ruleset requires `Bouncer` from the Gate App, and note its `integration_id`:

   ```bash
   gh api "repos/$REPO/rules/branches/main" \
     --jq '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks'
   ```

   The list holds the CI check and `Bouncer` with the ID of the Gate App. Run the command again with `--jq '[.[].type]'` to confirm that the rules include `merge_queue`.

2. Open a pull request that changes a file as a person with write access. The pull request shows a pending `Bouncer` run, not a failure. Read the check:

   ```bash
   HEAD_SHA=HEAD_COMMIT_SHA
   gh api "repos/$REPO/commits/$HEAD_SHA/check-runs?check_name=Bouncer&filter=latest" \
     --jq '.check_runs[] | {app: .app.slug, status, conclusion, title: .output.title}'
   ```

   One row appears, from the Gate App, with status `in_progress`. The Review Router posts no row.

3. Ask the second person to approve. The same command shows `completed` and `success` within about a minute.

4. Wait for the merge. The pull request enters the queue within about a minute of the approval, when the Gate finishes, and merges after the queue's checks. Confirm that the merge queue App merged it and that the queue ran the checks:

   ```bash
   gh pr view PR_NUMBER -R "$REPO" --json mergedBy --jq .mergedBy.login
   gh run list -R "$REPO" --event merge_group -L 3
   ```

   The first command prints `app/` followed by the name of the merge queue App. The second shows a successful `merge_group` run for the pull request.

5. Wait for the next Dependabot pull request, or edit `.github/dependabot.yml` to start an update run. A pull request inside the policy gets a `Bouncer` `success` from the Gate App within about a minute, gets no `Ready for Review` label or ownership comment, and merges through the queue.

When one step fails, see [Troubleshooting](troubleshooting.md) and the limits in [gate.md](gate.md#limits) and [merge-queue.md](merge-queue.md#limits).

## Roll back

Restore the required approvals on the ruleset and remove `Bouncer` from the required checks. The gate keeps posting and blocks nothing. Remove the `merge-queue.yml` workflow to stop enqueuing, and pull requests merge with a click as before.

## See also

- [Review Router gate](gate.md) for the rules the gate applies.
- [Merge queue App](merge-queue.md) for the enqueue workflow.
- [Dependabot auto-merge](auto-merge.md) for repositories without a merge queue.
