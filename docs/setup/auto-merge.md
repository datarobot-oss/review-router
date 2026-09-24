# Dependabot auto-merge

Dependabot PRs merge automatically once a person approves them and the required checks pass. The workflow queues GitHub's native auto-merge and never approves or merges on its own.

## How it works with review-router

1. Dependabot opens a PR.
2. Review-router labels it "Ready for Review" and routes it to the owning team (`dependabot.auto_label: true` in the org config).
3. The auto-merge workflow queues auto-merge on the PR.
4. A team member approves.
5. GitHub merges once every required check passes.

If a check fails, the PR stays open and labeled, and review-router's stale reminders keep it visible until someone acts.

## Setup

Copy [`.github/workflows/dependabot-auto-merge.yml`](../../.github/workflows/dependabot-auto-merge.yml) into your repo as-is. Your repo's maintainers own the copy. Change `MERGE_METHOD` only if your repo doesn't squash-merge.

Then configure the repo. The workflow checks all of this on every run and fails with an error naming anything missing:

- Turn on **Settings > General > Allow auto-merge**.
- Add a ruleset on the default branch that requires at least one approval.
- In a ruleset on the default branch, require at least one status check. Pick checks that run on every PR. A required check with a `paths:` filter never reports on PRs outside those paths, so they wait forever.
- Allow your `MERGE_METHOD` in the repo settings and in every ruleset.

The workflow reads rulesets only. `GITHUB_TOKEN` can't read classic branch protection, so repos that use it need to move to rulesets.

The required checks you choose in the ruleset are the checks auto-merge waits for. The workflow doesn't keep its own list.

## Limitations

- Merges performed with `GITHUB_TOKEN` don't trigger other workflows. Push-triggered jobs such as deploys or releases don't run after an auto-merged bump. The next human merge triggers them as usual.
- Don't combine this workflow with the `datarobot-oss/github-actions` automerge workflow. That one approves and merges on its own, and the two would compete for the same PRs.

## Security

The workflow runs on `pull_request_target`, so its definition always comes from the default branch and a PR can't change the logic that runs on it. It never checks out or runs PR code, uses only `GITHUB_TOKEN` scoped to the job, and needs no secrets.
