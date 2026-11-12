# Dependabot auto-merge

Dependabot PRs merge automatically once a person approves them and the required checks pass. The workflow queues GitHub's native auto-merge and never approves or merges on its own.

## How it works with review-router

1. Dependabot opens a PR.
2. Review-router labels it "Ready for Review" and routes it to the owning team (`dependabot.auto_label: true` in the org config). In a repository with the [gate](gate.md), it does so only when the gate waits for a person.
3. The auto-merge workflow queues auto-merge on the PR.
4. A team member approves.
5. GitHub merges once every required check passes.

If a check fails, the PR stays open and labeled, and review-router's stale reminders keep it visible until someone acts.

## Setup

Copy [`.github/workflows/dependabot-auto-merge.yml`](../../.github/workflows/dependabot-auto-merge.yml) into your repo as-is. Your repo's maintainers own the copy. Change `MERGE_METHOD` only if your repo doesn't squash-merge.

Then configure the repo. The workflow checks all of this on every run and fails with an error naming anything missing:

- Turn on **Settings > General > Allow auto-merge**.
- Add a ruleset on the branch Dependabot targets (usually the default branch) that requires at least one approval. In the same rule, turn on dismissing stale approvals or requiring approval of the most recent push. Otherwise an approval survives Dependabot refreshing the PR with newer versions, and changes nobody reviewed merge.
- In a ruleset on that branch, require at least one status check. Pick checks that run on every PR. A required check with a `paths:` filter never reports on PRs outside those paths, so they wait forever.
- Allow your `MERGE_METHOD` in the repo settings and in every ruleset.

The workflow reads rulesets only. `GITHUB_TOKEN` can't read classic branch protection, so repos that use it need to move to rulesets.

The required checks you choose in the ruleset are the checks auto-merge waits for. The workflow doesn't keep its own list.

The workflow only ever queues auto-merge. If a PR already meets every requirement when the workflow runs, it leaves a notice on the run and you merge the PR by hand.

## Limitations

- Merges performed with `GITHUB_TOKEN` don't trigger other workflows. Push-triggered jobs such as deploys or releases don't run after an auto-merged bump, and neither does the `closed` event, so review-router's label cleanup and Slack merge reaction skip these PRs. The next human merge triggers them as usual.
- A commit that a workflow pushes back to the PR with `GITHUB_TOKEN`, such as rebuilt generated files, gets no required checks. In a public repo, GitHub holds the `pull_request` runs for that commit until someone approves them, so auto-merge waits. Generate such files on the default branch instead, or approve the runs. A merge with `GITHUB_TOKEN` starts no push workflow, so files generated on the default branch update on the next push-triggered run.
- Don't combine this workflow with another automerge workflow that approves and merges on its own. The two would compete for the same PRs.

## Security

The workflow runs on `pull_request_target`, so its definition always comes from the default branch and a PR can't change the logic that runs on it. It never checks out or runs PR code, uses only `GITHUB_TOKEN` scoped to the job, and needs no secrets.
