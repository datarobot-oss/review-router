# Dependabot Auto-Merge

Automatically merge dependabot pull requests after they pass CI and
receive team approval. This pairs with review-router's
`dependabot.auto_label` feature for a fully automated dependency
update flow.

## How it works

1. Dependabot opens a PR
2. Review-router auto-labels it with "Ready for Review"
   (via `dependabot.auto_label: true` in config)
3. Review-router routes it to the appropriate team
4. The auto-merge workflow enables GitHub's native auto-merge on the PR
5. Once required status checks pass and the team approves, GitHub merges
   it automatically

## Prerequisites

- **Branch protection** must be enabled on the default branch with:
  - Required pull request reviews (at least 1)
  - Required status checks
  - "Allow auto-merge" enabled in repo settings
- **Review-router** configured with `dependabot.auto_label: true`

## Reusable workflow setup

### 1. Add the reusable workflow to your org's `.github` repo

Create `.github/workflows/dependabot-auto-merge.yml`:

```yaml
name: Dependabot Auto-Merge

on:
  workflow_call:

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-merge:
    if: github.actor == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - name: Enable auto-merge
        run: gh pr merge --auto --squash "$PR_URL"
        env:
          PR_URL: ${{ github.event.pull_request.html_url }}
          GH_TOKEN: ${{ github.token }}
```

### 2. Add the caller workflow to each downstream repo

Create `.github/workflows/dependabot-auto-merge.yml`:

```yaml
name: Dependabot Auto-Merge

on:
  pull_request_target:
    types: [opened]

jobs:
  auto-merge:
    uses: your-org/.github/.github/workflows/dependabot-auto-merge.yml@main
```

## Standalone setup (without reusable workflows)

If you don't use reusable workflows, add this directly to each repo:

```yaml
name: Dependabot Auto-Merge

on:
  pull_request_target:
    types: [opened]

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-merge:
    if: github.actor == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - name: Enable auto-merge
        run: gh pr merge --auto --squash "$PR_URL"
        env:
          PR_URL: ${{ github.event.pull_request.html_url }}
          GH_TOKEN: ${{ github.token }}
```

## How it interacts with review-router

The full flow for a dependabot PR:

```
dependabot opens PR
  → auto-merge workflow enables auto-merge (queued)
  → review-router auto-labels "Ready for Review"
  → review-router routes to team via CODEOWNERS
  → team reviews and approves
  → CI passes
  → GitHub merges automatically
```

The two workflows are independent — they trigger on different events
and can be adopted separately. Auto-merge does nothing without branch
protection rules that require reviews and status checks.

## Customization

**Merge strategy:** Change `--squash` to `--merge` or `--rebase` to
match your repo's preferred merge strategy.

**Minor updates only:** To only auto-merge minor/patch updates,
use dependabot's built-in grouping in `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      minor-and-patch:
        update-types:
          - minor
          - patch
```

Then adjust the workflow to only run for grouped PRs, or rely on
branch protection rules (require CI to pass) to gate major updates
that might break things.
