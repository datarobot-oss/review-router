# Review Router gate

The gate is a required status check named `Bouncer`, posted by the Review Router GitHub App. It replaces GitHub's required approvals on a branch ruleset, so a repository can merge trusted automation, such as Dependabot, without a person and still require one approval for everything else.

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

### Update the caller workflow

The gate runs inside the Review Router workflow. Add these triggers to the caller workflow of the repository:

```yaml
on:
  pull_request_target:
    types: [labeled, opened, closed, ready_for_review, synchronize, reopened]
  pull_request_review:
    types: [submitted, dismissed]
  merge_group:
    types: [checks_requested]
  schedule:
    - cron: "17 * * * *"
```

The gate reads the repository activity feed, so the Review Router App needs the **Contents: read** permission.

`synchronize` posts the result on a new head commit. `merge_group` posts the result on the commit of a merge queue entry. `schedule` re-evaluates every open pull request and fixes a result that no event updated. Editing a title, a description or a review starts no run, because none of them changes what the gate reads.

Every scheduled run also sends the stale review reminders to Slack when they are enabled. Set `interval_hours` in the `reminders` settings so a short schedule does not repeat each reminder. See [Stale PR Reminders](../../README.md#stale-pr-reminders). An hourly run costs about 10 API calls plus 10 per open pull request.

Add a concurrency group to the job so runs for one pull request finish in order. Without it, a slow run for an earlier event can post its result after a newer run blocked the pull request.

```yaml
concurrency:
  group: review-router-${{ github.event.pull_request.number || github.event.merge_group.head_ref || github.run_id }}
  cancel-in-progress: false
```

### API budget

Every run of the Review Router App draws on the API budget of its installation. Each organization has its own budget, and GitHub sets it by plan. See the GitHub [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) for the current values.

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

If an organization outgrows its budget, lengthen the schedule. A second token doesn't add budget, because the installation owns it. Each scheduled run logs the calls it used.

## Require the gate

Report first. With the policy file in place and no ruleset change, the gate posts results and blocks nothing. Check the results on a few pull requests, then edit the ruleset of the default branch in one change:

1. Set required approvals to `0` and turn off code owner review.
2. Add `Bouncer` to the required status checks, pinned to the Review Router GitHub App.

To roll back, restore the required approvals and remove the check from the ruleset. The gate keeps posting and blocks nothing.

## Limits

- The gate is as strong as write access to the repository. The Review Router key is an organization secret that a workflow in the repository can read, so a person who can push a workflow can mint a token and post a passing result. Treat write access as the trust boundary until the gate runs under its own GitHub App.
- The gate posts nothing between a push and the first run, so a new commit shows the required check as expected, with no link, until the run posts.
- A pending run stays until a person approves or the next push.
- The Review Router reads the gate's decision for a Dependabot pull request when it opens, when it gets a push, and on the scheduled run. The scheduled run routes only a pull request with no review label and no ownership comment, so a label someone removed stays removed. A pull request whose approval is dismissed after routing isn't routed again. Add the `Ready for Review` label by hand.
- A review on a pull request from a fork starts no run with secrets. A change request or a dismissal on such a pull request takes effect at the next scheduled run, and a merge queue re-evaluates it when the pull request enters the queue.
- A pull request from a fork whose push history the App can't read, such as a private fork, stays blocked. Merge it through a branch of the repository instead.
- Dependabot lists no update type for indirect dependencies and some security updates. The gate derives it from the two versions, which needs a version number that starts with digits. Date-based versions count as comparable numbers.
- A `Co-authored-by` trailer doesn't count as authorship, because anyone can write one. A person with write access who appears only in a trailer can approve the pull request.
- A pull request with more than 250 commits, 3000 changed files, or 100 pushes to its branch fails closed.
