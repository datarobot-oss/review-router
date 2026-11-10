# Merge queue App

A merge queue App adds a pull request to GitHub's merge queue once it is ready, so nobody clicks **Merge when ready**. Together with the [gate](gate.md), it merges a pull request as soon as it has the approvals and checks that the branch ruleset requires.

The queue still runs the required checks on each entry before it merges. The App decides only when a pull request enters the queue.

## Why a separate App

Two tokens that look like the obvious choice can't do the job:

- Native auto-merge that a workflow enables with `GITHUB_TOKEN` never adds the pull request to the queue.
- An enqueue with `GITHUB_TOKEN` creates the entry, but the queue then starts no `merge_group` workflows. The entry waits for the check timeout and the queue removes it.
- The Review Router App can't enqueue, because enqueuing needs the **Contents: write** permission and the Review Router App keeps **Contents: read**.

A token from a dedicated App starts workflows like a person's click does. The merge queue App has the permissions to enqueue and nothing else.

## What the App enqueues

The `merge-queue` workflow runs the enqueue job only when the rules on the default branch are safe for the App, because the App can add a pull request to the queue. The rules need all of these:

- A merge queue rule.
- At least one required status check.
- A review control, which is either one required approval or a required `Bouncer` check.

When a rule is missing, the run posts a warning that names it and the App stays idle.

For each open pull request, the job enqueues only when GitHub reports the merge state as `CLEAN`, so every approval and required check has passed. It skips a pull request in these cases:

- The pull request is a draft or comes from a fork. A fork pull request needs a person to enqueue it.
- The pull request has the `hold` label.
- The pull request is in the queue already.
- A newer commit exists than the one that triggered the run.

The enqueue call carries the head commit, so GitHub refuses it when a commit lands after the checks pass.

## Create the merge queue App

Create a GitHub App in your organization with these settings:

| Setting                | Value                                                                         |
| ---------------------- | ----------------------------------------------------------------------------- |
| Name                   | Any name, for example `Review Router Merge Queue`.                            |
| Homepage URL           | Any URL, for example the page of this guide.                                  |
| Webhook                | Inactive.                                                                     |
| Repository permissions | Contents: read and write. Pull requests: read and write. Metadata: read-only. |
| Where to install       | Only on this account.                                                         |

Generate a private key and keep it in a password manager. Install the App on the repositories that use the queue. Note the **Client ID** from the App's settings page.

> [!IMPORTANT]
> **Contents: write** lets a token push to any branch that no ruleset protects. Protect every branch that matters with a ruleset, and treat the key like the key of the [Gate App](gate.md#run-the-gate-under-its-own-app).

## Store the key in an environment

Store the App's identity in a `merge-queue` environment that only the default branch can read, as the gate does for the Gate App. Run these commands as a repository administrator. Use the Client ID and the key file of your App:

```bash
REPO=OWNER/REPO
gh api -X PUT "repos/$REPO/environments/merge-queue" \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST "repos/$REPO/environments/merge-queue/deployment-branch-policies" -f name=main
gh variable set MERGE_APP_CLIENT_ID --env merge-queue -R "$REPO" --body "Iv23liEXAMPLE"
gh secret set MERGE_APP_PRIVATE_KEY --env merge-queue -R "$REPO" < private-key.pem
```

Replace `main` with the default branch. Don't add another branch to the environment, because every allowed branch can read the key.

## Add the workflow

The workflow calls two shell scripts. Copy them into `scripts/` on the default branch from the reference copies in the Hermes agent repository:

- [`merge-queue-posture.sh`](https://github.com/datarobot-labs/datarobot-labs-hermes-agent/blob/main/scripts/merge-queue-posture.sh) checks the rules on the default branch.
- [`merge-queue-enqueue.sh`](https://github.com/datarobot-labs/datarobot-labs-hermes-agent/blob/main/scripts/merge-queue-enqueue.sh) adds one pull request to the queue.

Create `.github/workflows/merge-queue.yml`. Replace `CI` in `workflows` with the name of the workflow that runs your required checks:

```yaml
name: merge-queue

on:
  workflow_run:
    workflows: [CI]
    types: [completed]
  schedule:
    - cron: "*/15 * * * *"
  workflow_dispatch:

permissions: {}

jobs:
  posture:
    # CI for a merge group is the queue's own check, nothing to enqueue.
    if: >-
      github.event_name != 'workflow_run' ||
      (github.event.workflow_run.event == 'pull_request' &&
       github.event.workflow_run.conclusion == 'success')
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
    outputs:
      ready: ${{ steps.posture.outputs.ready }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          sparse-checkout: scripts
      - id: posture
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          BASE: ${{ github.event.repository.default_branch }}
        run: sh scripts/merge-queue-posture.sh

  enqueue:
    needs: posture
    if: needs.posture.outputs.ready == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    concurrency:
      group: merge-queue
    environment: merge-queue
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          sparse-checkout: scripts
      - id: token
        uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0
        with:
          client-id: ${{ vars.MERGE_APP_CLIENT_ID }}
          private-key: ${{ secrets.MERGE_APP_PRIVATE_KEY }}
          permission-contents: write
          permission-pull-requests: write
      - name: Add the ready pull requests to the merge queue
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
          REPO: ${{ github.repository }}
          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
          EVENT: ${{ github.event_name }}
          PR_NUMBER: ${{ github.event.workflow_run.pull_requests[0].number }}
          HEAD_SHA: ${{ github.event.workflow_run.head_sha }}
        run: |
          set -eu
          if [ "$EVENT" = workflow_run ]; then
            # The merge state needs a moment to settle after the last check completes.
            WAIT_SECONDS=30 sh scripts/merge-queue-enqueue.sh "$PR_NUMBER" "$HEAD_SHA"
          else
            for pr in $(gh pr list --state open --base "$DEFAULT_BRANCH" --json number --jq '.[].number'); do
              sh scripts/merge-queue-enqueue.sh "$pr" || echo "::warning::PR $pr could not be added to the queue."
            done
          fi
```

Keep these properties of `merge-queue.yml`:

- `workflow_run` and `schedule` run the file on the default branch, so a pull request can't change the logic that runs on it. Don't add a `pull_request` trigger or a checkout of a pull request.
- The enqueue job reads fields from the API and never runs pull request code.
- `environment: merge-queue` gives the job the key. A job on any other branch can't declare it.
- The `posture` job uses the workflow token with `contents: read` and holds no key.
- The concurrency group runs one enqueue job at a time.

## Require the merge queue

Add a merge queue rule to the ruleset of the default branch, and keep the required checks and the review control next to it. See the GitHub documentation on [managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges/configuring-pull-request-merges/managing-a-merge-queue) for the settings.

The queue runs the required checks again on a temporary merge commit, with the `merge_group` event. Every workflow that provides a required check needs the `merge_group` trigger, or the entry waits for the check timeout and the queue removes it.

Add the `hold` label to a pull request to keep it out of the queue.

## Limits

- A pull request that an approval makes `CLEAN` after its checks finished waits for the next scheduled run, which is up to 15 minutes. The `workflow_run` trigger covers a pull request that is ready when CI completes.
- A merge with `GITHUB_TOKEN` starts no push workflow, so Release jobs and deploys don't run after one. The queue merges as the App, whose events start workflows.
- The App holds **Contents: write**, so its key is worth more than the Gate App key. Install the App on the repositories that use the queue and no others.
- A repository on a plan without merge queues can't use the App. Merge queues are available in public repositories owned by an organization, and in private repositories on GitHub Enterprise Cloud.
