# Review Router gate

The gate is a required status check named `Bouncer`, posted by a GitHub App. It replaces GitHub's required approvals on a branch ruleset, so a repository can merge trusted automation, such as Dependabot, without a person and still require one approval for everything else.

A separate Gate App posts the check, and the ruleset requires it from that App only. The Gate App's key is out of reach of a workflow on a branch. The Review Router App never posts `Bouncer`. See [Run the gate under its own App](#run-the-gate-under-its-own-app).

## How the gate decides

The gate posts one result per pull request head commit. The result is `success`, `action_required`, or a pending run. Both `neutral` and `skipped` satisfy a required check, so the gate never posts them.

A pull request that waits for an approval shows a pending `Bouncer` run, which blocks the merge like any pending required check and shows a yellow dot, not a red cross. `action_required` stays for a change request and for an error. A merge queue entry that lacks an approval gets `action_required`, so the queue fails it at once instead of holding the queue until its timeout.

The gate checks these rules in order:

1. A person with write access whose latest review requests changes blocks the pull request.
2. A person approves the pull request when all of these hold:
   - The reviewer has write or admin access and is a user, not an App or a bot.
   - The review is on the current head commit.
   - The reviewer is not the author, did not author or commit any commit in the pull request, and never pushed to its branch. The push history comes from the repository activity feed, because commit emails can name anyone.
3. A policy family passes the pull request without a review when every rule of the family holds.
4. Otherwise the pull request waits for a person.

An error while reading the pull request posts `action_required` with the reason, so the gate fails closed. When the error happens before the pull request is read, the gate replaces an earlier result on that commit. A commit with no result stays blocked by the missing required check.

### Dependabot family

The family passes a pull request when all of these hold:

- The author is `dependabot[bot]`, and the branch is a `dependabot/` branch of the same repository.
- Every commit has the author `dependabot[bot]`, the committer `web-flow`, and a verified signature.
- Only `dependabot[bot]` pushed to the branch. Any token with write access can create a commit that looks like Dependabot's, so the push history is the proof.
- No changed file is under `.github/`.
- Every changed file, including the previous name of a renamed file, matches `allowed_paths`.
- The pull request changes at most `max_changed_files` files.
- Every dependency in the commit metadata passes the dependency settings and rules below. A grouped update passes only when each of its dependencies does. A commit whose metadata is missing or unreadable sends the whole pull request to a person.

An account that pushes to the Dependabot branch moves the pull request to the approval rule. That includes a person, a merge commit from the **Update branch** button, and an automation that commits to the branch, such as a CI job that rebuilds generated files.

A pull request the family passes needs no reviewer, so the Review Router doesn't route it: no `Ready for Review` label, ownership comment, Slack message or reminder, even with `dependabot.auto_label` on. When a pull request opens or gets a push and the gate waits for a person, the Review Router adds the label and routes it as usual. The scheduled run does the same for a pull request the gate stops passing without a push, such as after a policy change on the default branch, if nobody routed it before.

## Enable the gate

A repository joins the gate when its default branch holds `.github/review-router.yml`, or when a ruleset on the default branch requires `Bouncer`. The gate reads the policy from the default branch only, so a pull request can't change the rules it is judged by.

Create `.github/review-router.yml` on the default branch:

```yaml
dependabot:
  allowed_paths:
    - requirements/**
    - Dockerfile
  max_changed_files: 10
  defaults:
    update_types: [patch, minor]
    min_compatibility: 70
  rules:
    - match: { dependency: "@types/*" }
      update_types: [patch, minor, major]
      min_compatibility: 0
    - match: { dependency: cryptography }
      action: human
```

| Key                 | Default   | Description                                                                                                                                                                         |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowed_paths`     | none      | Glob patterns for the files the pull request may change. `*` stays in one directory, `**` spans directories. An empty list turns the family off. Files under `.github/` never pass. |
| `max_changed_files` | `10`      | Largest number of changed files. A renamed file counts once.                                                                                                                        |
| `defaults`          | see below | The risk settings for every dependency.                                                                                                                                             |
| `rules`             | none      | Ordered overrides for dependencies that match.                                                                                                                                      |

An unknown key inside `dependabot` is an error, so a typo can't silently remove a limit. Unknown keys at the top of the file are ignored, so a newer file still parses.

### Dependency settings

Set these in `defaults`, or in a rule to change them for the dependencies it matches. A rule changes only the settings it lists.

| Setting                 | Default                               | Description                                                                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ecosystems`            | `[npm_and_yarn, pip, uv, go_modules]` | Dependabot ecosystems that pass. Write the name from `dependabot.yml` (`npm`, `gomod`, `github-actions`) or from the `dependabot/<ecosystem>/` branch. An unknown name is an error. Others, such as `docker` and `github_actions`, go to a person until listed. |
| `update_types`          | `[patch, minor]`                      | Sizes of version bump that pass: `patch`, `minor`, `major`. Also valid directly under `dependabot` as a shorthand for `defaults.update_types`.                                                                                                                  |
| `dependency_types`      | all three                             | Kinds that pass: `direct:production`, `direct:development`, `indirect`.                                                                                                                                                                                         |
| `min_compatibility`     | `70`                                  | Lowest Dependabot compatibility score (the badge in the pull request body), 0 to 100. `0` turns the score off.                                                                                                                                                  |
| `unknown_compatibility` | `human`                               | What happens when no score exists: `human` or `pass`.                                                                                                                                                                                                           |
| `unknown_update_type`   | `derive`                              | When the metadata has no update type, `derive` it from the two versions, or send the dependency to a `human`. Indirect dependencies and some security updates have none.                                                                                        |
| `zero_minor_is_major`   | `true`                                | Count a minor bump below version 1.0 as a major bump.                                                                                                                                                                                                           |
| `allow_prerelease`      | `false`                               | Pass a prerelease version. A hyphen after the numbers (`1.0.0-M1`, `21-ea`, a Go pseudo-version), a suffix such as `2.0.0b1`, and words such as `.dev` all count.                                                                                               |

The gate builds the score lookup from the dependency name, ecosystem and the two versions, so grouped updates get a score too. It asks `dependabot-badges.githubapp.com` for at most 30 dependencies per pull request and only when a setting needs the score. A failed or missing answer counts as no score. A runner that can't reach that host sends every dependency to a person, unless `min_compatibility` is `0`, `unknown_compatibility` is `pass`, or a rule passes the dependency. After 3 failed requests in a row the gate stops asking for the rest of the run, and it never follows a redirect.

### Rules

A rule has a `match`, and either an `action` or settings. A `match` takes `dependency` (a name glob where `*` also matches a slash, compared without case and with `-`, `_` and `.` alike for pip and uv, and exactly for other ecosystems), `ecosystem`, `dependency_type`, `update_type` and `group`. Every key of a match must hold.

The gate decides each dependency in this order:

1. If any matching rule has the action `human`, the dependency goes to a person, wherever that rule sits.
2. Otherwise the first matching rule decides. The action `pass` passes the dependency without the risk settings. Settings replace the defaults they name.
3. With no matching rule, the defaults apply.

The check summary names the rule that decided each dependency.

Rules change the risk settings only. They never change who may be the author, the push history, the commit signatures, the `.github/` block, or `allowed_paths`.

A policy file with an error leaves the repository in the gate with no family. Approvals by a person still pass.

### Review Router workflow

The Review Router posts no `Bouncer` result and needs no gate trigger. For a Dependabot pull request it reads the gate's decision, without posting it, to decide whether the pull request needs a reviewer. The gate reads the repository activity feed, so the Review Router App needs the **Contents: read** permission.

The Gate App workflows that post the result are in [Run the gate under its own App](#run-the-gate-under-its-own-app).

### API budget

Every run of the Review Router App and the Gate App draws on the API budget of its installation. Each organization has its own budget, and GitHub sets it by plan. See the GitHub [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) for the current values.

| Organization                                           | API calls per hour                                           |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| 20 or fewer repositories and users                     | 5,000                                                        |
| More than 20 repositories or users, without Enterprise | 5,000, plus 50 per repository or user above 20, up to 12,500 |
| GitHub Enterprise Cloud                                | 15,000                                                       |

A scheduled run uses about 10 calls plus 10 per open pull request, and doesn't start when less than 20% of the budget remains. The gate sweep checks the budget again after every 25 pull requests and stops at the same threshold. It starts one batch further along each hour, so a pull request it skipped comes up within a few runs. Event-driven runs share the budget. The table shows how many open pull requests one hourly schedule handles. The estimates come from the code, not from measurements.

| Budget | Scheduled sweep alone | Leaving half of the budget for event-driven runs |
| ------ | --------------------- | ------------------------------------------------ |
| 5,000  | about 400             | about 250                                        |
| 12,500 | about 1,000           | about 600                                        |
| 15,000 | about 1,200           | about 750                                        |

If an organization outgrows its budget, lengthen the schedule. A second token doesn't add budget, because the installation owns it. The Gate App installation has its own budget, so the gate sweep doesn't draw on the Review Router's. Each scheduled run logs the calls it used.

## Run the gate under its own App

The Gate App posts `Bouncer`. Its key is a secret of an environment that only the default branch can read, and the ruleset requires `Bouncer` from the Gate App only. The Review Router key is an organization secret that a workflow in an enrolled repository can read, so the Review Router App never posts the check. A person who can push a workflow can't use that key to post a passing result.

The Gate App runs this action with `mode: gate`, so the decision logic stays in one place.

The Gate App posts results only for a repository that has joined the gate. [Enable the gate](#enable-the-gate) first: the default branch needs `.github/review-router.yml`, or a ruleset that requires `Bouncer`.

> [!IMPORTANT]
> An App's private key mints a token for every installation of that App. By default, create the Gate App in your own organization and install it only on repositories whose administrators you trust with the key. To share one App across organizations, one team must own it and enroll each repository itself. See [Choose who owns the Apps](repository-setup.md#choose-who-owns-the-apps).

### Create the Gate App

Create a GitHub App in your organization with these settings:

| Setting                | Value                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Name                   | Any name, for example `Review Router Gate`.                                                 |
| Homepage URL           | Any URL, for example the page of this guide.                                                |
| Webhook                | Inactive.                                                                                   |
| Repository permissions | Checks: read and write. Pull requests: read-only. Contents: read-only. Metadata: read-only. |
| Where to install       | Only on this account.                                                                       |

Generate a private key and keep it in a password manager. Delete the downloaded file after you upload the key to your repositories. Install the App on the repositories that use the gate. Note the **Client ID** and the **App ID** from the App's settings page.

### Store the key in an environment

An environment secret reaches only a job that declares the environment, and a deployment branch policy decides which branches may declare it. Create a `gate` environment in each repository, allow only the default branch, and store the App's identity in it. Run these commands as a repository administrator. Use the Client ID, the App ID and the key file of your App:

```bash
REPO=OWNER/REPO
gh api -X PUT "repos/$REPO/environments/gate" \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST "repos/$REPO/environments/gate/deployment-branch-policies" -f name=main
gh variable set GATE_APP_CLIENT_ID --env gate -R "$REPO" --body "Iv23liEXAMPLE"
gh variable set GATE_APP_ID --env gate -R "$REPO" --body "123456"
gh secret set GATE_APP_PRIVATE_KEY --env gate -R "$REPO" < private-key.pem
```

Replace `main` with the default branch. Don't add another branch to the environment, because every allowed branch can read the key.

The environment trusts the default branch, so a person who can push to it can read the key. Before you rely on the gate, require a pull request on the default branch and block direct pushes and force pushes. Private repositories need a GitHub plan that includes environments.

To rotate the key, generate a second key on the App's settings page, run the last command with the new file for each repository, then delete the old key. Both keys work in between.

### Add the workflows

Add two workflows on the default branch. The `pull_request_review` and `merge_group` events run the workflow file of the pull request or the queue entry, so a workflow that holds a secret can't listen to them. `Gate trigger` listens to those events with no secrets and no permissions. It starts `Gate` through `workflow_run`, which always runs the file on the default branch.

Create `.github/workflows/gate-trigger.yml`. The `workflow_run` event names this workflow, so keep the name:

```yaml
name: Gate trigger

on:
  pull_request_review:
    types: [submitted, dismissed]
  merge_group:
    types: [checks_requested]

permissions: {}

jobs:
  announce:
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - run: echo "event $GITHUB_EVENT_NAME"
```

Create `.github/workflows/gate.yml`. Replace `<COMMIT_SHA>` with the commit that the `v1` tag points to. The command is below the workflow.

```yaml
name: Gate

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_run:
    workflows: [Gate trigger]
    types: [completed]
  schedule:
    - cron: "17 3,9,15,21 * * 1-5"

permissions: {}

concurrency:
  group: gate-${{ github.event.pull_request.head.sha || github.event.workflow_run.head_sha || github.run_id }}
  cancel-in-progress: false

jobs:
  gate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: gate
    steps:
      - id: token
        uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0
        with:
          client-id: ${{ vars.GATE_APP_CLIENT_ID }}
          private-key: ${{ secrets.GATE_APP_PRIVATE_KEY }}
          permission-checks: write
          permission-pull-requests: read
          permission-contents: read

      - uses: datarobot-oss/review-router@<COMMIT_SHA> # main
        with:
          mode: gate
          github-token: ${{ steps.token.outputs.token }}
          gate-app-id: ${{ vars.GATE_APP_ID }}
```

Keep these properties of `gate.yml`:

- `workflow_run` and `schedule` run the file on the default branch, and `pull_request_target` runs the file of the pull request's base branch. The gate handles pull requests into the default branch only. A pull request into another branch fails the job at the environment check, because the environment allows only the default branch.
- Don't add a `pull_request` trigger, a checkout, or a shell step. The job calls the API and never runs pull request code.
- `environment: gate` gives the job the key. A job on any other branch can't declare it.
- `Gate` runs after every completed run of `Gate trigger`, including a failed one, because a failed trigger must not skip the evaluation.
- The concurrency group serializes the event runs for one commit, so a run that read the pull request before an approval was dismissed can't post its result over a later block.
- The `schedule` trigger re-evaluates every open pull request into the default branch and fixes a result that no event updated. The sample cron runs four times a day on weekdays, so a result can stay out of date for up to three days after a policy change over a weekend. Use `17 * * * *` to sweep hourly, and see [API budget](#api-budget).
- `gate-app-id` must be the ID of the App behind the token. When it isn't, the action fails with `gate-app-id is N, but the check was created by App M`.

Pin the action to a commit, not to `v1`. The job holds the key that lets a pull request merge, and a floating tag moves without a review. Read the commit that `v1` points to, and move the pin in a pull request:

```bash
gh api repos/datarobot-oss/review-router/commits/v1 --jq .sha
```

Workflow linters such as zizmor flag `pull_request_target` and `workflow_run` in `gate.yml`. The warning targets workflows that run pull request code. This one doesn't, so ignore it for this file only.

### Check the results

Check the result on a few pull requests, including one that waits for an approval, one with an approval, and one that goes through the merge queue. Set `HEAD_SHA` to the head commit of the pull request, or to the commit of the queue entry:

```bash
REPO=OWNER/REPO
HEAD_SHA=HEAD_COMMIT_SHA
gh api "repos/$REPO/commits/$HEAD_SHA/check-runs?check_name=Bouncer&filter=latest" \
  --jq '.check_runs[] | {app: .app.slug, status, conclusion, title: .output.title}'
```

Each commit shows one `Bouncer` run, from the Gate App. Then follow [Require the gate](#require-the-gate) and pin `Bouncer` to the Gate App.

## Require the gate

Report first. With the policy file in place and no ruleset change, the gate posts results and blocks nothing. Check the results on a few pull requests, then edit the ruleset of the default branch in one change:

1. Set required approvals to `0` and turn off code owner review.
2. Add `Bouncer` to the required status checks, pinned to the Gate App.
3. Require a merge queue. The queue evaluates the gate again for each entry, which covers the review events that a writer can suppress. See [Limits](#limits).

In the ruleset editor, choose the App as the source of the check. In the rulesets API, set `integration_id` on the check in `required_status_checks` to the App ID. A check with no source accepts a result from any App.

Pin the check in the same edit that sets the approvals to `0`. A check with no source and no approval requirement accepts a result from any App that can post checks.

To roll back, restore the required approvals and remove the check from the ruleset. The gate keeps posting and blocks nothing.

## Limits

- A workflow on a branch can't read the Gate key. It can read the Review Router key and the other organization secrets, and post a `Bouncer` result with the Review Router key. The ruleset doesn't count that result, because the required check names the Gate App.
- A person with write access controls the copy of `Gate trigger` that runs on the review events of their own pull request. They can delete it or make it fail, so a dismissal or a change request starts no re-evaluation, and the last result stands until the next scheduled run. A merge queue closes the gap: each entry runs `merge_group`, which gives the queue commit a fresh result, and an entry with no result fails when the check timeout ends. Require a merge queue, and sweep hourly to shorten the window.
- The Gate App doesn't stop an administrator, who can bypass the ruleset or change the `gate` environment, or two people with write access who approve each other's pull requests. Treat administrators and colluding writers as the remaining risk.
- The gate posts nothing between a push and the first run, so a new commit shows the required check as expected, with no link, until the run posts.
- A pending run stays until a person approves or the next push.
- The Review Router reads the gate's decision for a Dependabot pull request when it opens, when it gets a push, and on the scheduled run. The scheduled run routes only a pull request with no review label and no ownership comment, so a label someone removed stays removed. A pull request whose approval is dismissed after routing isn't routed again. Add the `Ready for Review` label by hand.
- A pull request from a fork whose push history the App can't read, such as a private fork, stays blocked. Merge it through a branch of the repository instead.
- Dependabot lists no update type for indirect dependencies and some security updates. The gate derives it from the two versions, which needs a version number that starts with digits. Date-based versions count as comparable numbers.
- A `Co-authored-by` trailer doesn't count as authorship, because anyone can write one. A person with write access who appears only in a trailer can approve the pull request.
- A pull request with more than 250 commits, 3000 changed files, or 100 pushes to its branch fails closed.
