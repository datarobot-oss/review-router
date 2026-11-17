# Slack Custom Emojis

Review-router notifications work out of the box with standard Slack emojis.
These custom emojis are optional upgrades for a more polished look.

To use them, add them to your Slack workspace and override the defaults
in your `config.yml`:

```yaml
reactions:
  enabled: true
  icons:
    header: "rr-mag"
    branch: "rr-twisted_rightwards_arrows"
    commits: "rr-git_commit"
    files: "rr-file"
    labels: "rr-label"
    cta: "rr-point_right"
    comment: "rr-speech_balloon"
    mention: "rr-at"
    description_mention: "rr-bell"
    review_requested: "rr-eyes"
    assigned: "rr-eyes"
  approved: "github_approve"
  merged: "merged"
  closed: "closed"
```

## How to add

1. Go to your Slack workspace settings
2. Navigate to **Customize** > **Emoji**
3. Click **Add Emoji** for each file below
4. Use the filename (without `.png`) as the emoji name

## Emojis

| File | Emoji name | Used for |
|------|-----------|----------|
| `rr-mag.png` | `:rr-mag:` | Notification header icon |
| `rr-git-commit.png` | `:rr-git_commit:` | Commit count in footer |
| `rr-file.png` | `:rr-file:` | File count in footer |
| `rr-label.png` | `:rr-label:` | Labels in footer |
| `rr-twisted_rightwards_arrows.png` | `:rr-twisted_rightwards_arrows:` | Branch name in footer |
| `rr-point_right.png` | `:rr-point_right:` | Link that closes a message (`cta`) |
| `rr-speech_balloon.png` | `:rr-speech_balloon:` | Comment DM (`comment`) |
| `rr-at.png` | `:rr-at:` | Mention DM for a comment or review (`mention`) |
| `rr-bell.png` | `:rr-bell:` | Mention DM for a PR description (`description_mention`) |
| `rr-eyes.png` | `:rr-eyes:` | Review requested and Assigned DMs (`review_requested`, `assigned`) |
