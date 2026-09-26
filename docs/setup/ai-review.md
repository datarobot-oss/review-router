# AI review

Review Router can post an automated code review, run by Claude Code through DataRobot's LLM Gateway. It reviews a PR when it gets the ready label, and again whenever an org member comments `/ai-review`.

## What it does

1. Downloads the PR's files as a tarball. It never checks out or runs PR code.
2. Builds a context directory: the diff, the PR description with other bots' blocks removed, recent history of the changed files, a script-built map of where changed functions are called, and review rules from the base branch.
3. Runs two read-only review passes in parallel: one checks the PR's claims and the callers of changed functions, one checks the repo's own review rules. Sessions can only read, search, and list files.
4. Scores each medium- and high-severity candidate in its own session and keeps scores at or above the threshold.
5. Posts one review with inline comments. It never approves or requests changes.

A review usually takes about 5 minutes and costs about $1 to $1.50 at list price, capped by `max_cost_usd`.

## Enable it

1. Store a DataRobot API token for a service account as the `REVIEW_ROUTER_AI_TOKEN` secret, at the org or repo level.
2. Pass it to the action in your reusable workflow:

   ```yaml
   - uses: datarobot-oss/review-router@v1
     with:
       # ...existing inputs...
       ai-token: ${{ secrets.REVIEW_ROUTER_AI_TOKEN }}
   ```

   Also declare `REVIEW_ROUTER_AI_TOKEN` under `on.workflow_call.secrets`.

3. Add an `ai_review` block for the org in `config.yml`:

   ```yaml
   orgs:
     your-org:
       ai_review:
         enabled: true
         repos: [api, web]
         endpoint: https://app.eu.datarobot.com/api/v2
         models:
           reviewer: bedrock/anthropic.claude-sonnet-5
           scorer: bedrock/anthropic.claude-sonnet-5
         threshold: 70 # optional, 0-100
         max_cost_usd: 3 # optional
   ```

   Model ids must exist in the endpoint's LLM Gateway catalog.

If a caller workflow skips comments with `contains(github.event.comment.body, '/review')`, that filter drops `/ai-review`, because `/ai-review` doesn't contain the substring `/review`. Add `|| contains(github.event.comment.body, '/ai-review')` to it.

## Per-repo guidance

Put free-form guidance for the reviewer in `.github/ai-review.md`, for example which areas matter most or which generated files to ignore. If the repo has Cursor Bugbot rules in `.cursor/*.md`, the rules pass uses them too. Both are read from the PR's base branch, so a PR can't change the rules that review it.

## When it doesn't run

- Fork PRs, always.
- PRs opened by bots, on the label trigger. A member can still comment `/ai-review`.
- `/ai-review` from anyone who isn't an org member, owner, or collaborator.
- A label trigger for a commit that already has an AI review. Comment `/ai-review` to review again.

## Limits

- Two triggers on the same PR at the same time both run and both post.
- Costs in the review footer are Claude Code's list-price estimates, not DataRobot's actual cost.
- The LLM Gateway caps prompts per user per day. A review uses about 50.
