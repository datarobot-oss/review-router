# Slack notifications

Review Router sends Slack messages to team channels and direct messages (DMs) to people. This page lists each message, who gets it, and how to turn it off or fix it when it doesn't arrive.

## What Review Router sends

Each row is one trigger. A DM goes to the person's Slack account. If DMs are off or a DM fails, the message goes to the [Slack thread](#thread-replies) instead.

| Trigger                                                                               | Who gets it                                                      | Where        |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------ |
| A PR gets the "Ready for Review" label and is routed                                  | The channel of each owning team, with a cc for individual owners | Team channel |
| A PR stays unreviewed past `stale_hours`, with reminders on                           | The channel of each team that still needs to review              | Team channel |
| Someone adds a person, not a team, to the PR's reviewers, or re-requests their review | That person                                                      | DM           |
| Someone approves the PR                                                               | The PR author                                                    | DM           |
| Someone other than the author comments, replies inline, or submits a review           | The PR author                                                    | DM           |
| Someone other than the author comments or replies inline                              | The PR's assignees                                               | DM           |
| Anyone writes `@login` in a comment, an inline comment, or a review summary           | The mentioned person                                             | DM           |

A review that requests changes follows the last row only. Its summary reaches the people it mentions, and nobody else.

Review Router sends nothing for these:

- Comments and reviews from bots.
- Comments that Review Router itself posts.
- The `/review` and `/ai-review` commands.
- A comment that the PR author writes without mentioning anyone. The author already knows.

One event sends one DM per person. An author who is also an assignee and a mentioned person gets a single DM.

## Set up DMs

DMs need three things:

1. A `users` mapping in the config from each GitHub login to a Slack user ID. For the file format, see [External config](external-config.md). Without an entry, the person gets nothing.
2. The `chat:write` scope on the Slack app.
3. The **Messages** tab turned on in the Slack app's **App Home** page.

Without the scope or the Messages tab, the DM fails and Review Router sends the [thread reply](#thread-replies) instead.

```yaml
users:
  johndoe: U01ABC123
  janedoe: U02DEF456
```

The login match ignores case. A GitHub login with no entry in `users` gets no DM.

DMs are on by default. To turn them off for an org, set `notifications.dm.enabled`:

```yaml
orgs:
  my-org:
    notifications:
      dm:
        enabled: false
```

To stop DMs for yourself, mute the bot's conversation in Slack.

## Mentions

A mention is `@login`, written in a comment, an inline comment, or a review summary. The mentioned person gets a DM from anyone, including the PR author.

These don't count as mentions:

- A login inside inline code or a fenced code block.
- A login in a quoted line, which starts with `>`.
- A login inside an HTML comment.
- A team mention such as `@datarobot/labs`.
- An email address such as `dev@example.com`.
- A mention of yourself.

## Ask for a review by name

When someone adds a person to the **Reviewers** list, or re-requests their review, that person gets a DM that says who asked. Team requests, requests that a bot makes, and a request for your own review send nothing.

The workflow must listen for the `review_requested` event. Add it to the `pull_request_target` types:

```yaml
on:
  pull_request_target:
    types: [labeled, opened, closed, ready_for_review, review_requested]
```

A repository that doesn't list the type gets no review request DMs. The other messages don't change.

## Thread replies

When a DM is off or fails, Review Router replies in the Slack thread of the PR's original channel message and mentions the person. Review Router finds the thread through a hidden marker it writes when it posts the channel message, so a PR that was never routed has no thread, and nobody is notified.

To silence the thread for one PR, add a `:mute:` or `:no_bell:` reaction to the Slack message. DMs ignore this reaction.

> [!NOTE]
> The person must be a member of the Slack channel to get the mention. This is a Slack limit for private channels.

## Fork PRs

GitHub withholds secrets from review and comment runs that belong to a PR from a fork. Review Router can't send a DM at that moment, so each `schedule` run replays the events it missed. A fork PR in a repository without a `schedule` trigger gets no DMs.

How the replay works:

- **Delay.** A DM arrives on the next scheduled run. With the default schedule, `0 3,9,15,21 * * 1-5`, that is up to 6 hours, and nothing runs on weekends. An hourly schedule shortens the wait.
- **Replay marker.** Review Router records how far it replayed in a hidden marker in its code ownership comment. A run never sends the same event twice.
- **First run.** On a PR opened less than 7 days ago, the replay starts at the creation time. On an older PR, it starts now and skips earlier events.
- **Bursts.** A reviewer who leaves many inline comments gets one DM to the author for the burst. A later comment in the burst sends a DM only when it mentions someone new, and only to that person.

For events that need no secrets, such as routing and labels, the workflow runs in real time on `pull_request_target`.

## Troubleshooting

If a DM doesn't arrive, check these in order:

1. The workflow lists the event type: `pull_request_review`, `pull_request_review_comment`, `issue_comment`, and `review_requested` for review requests.
2. The workflow passes `slack-token`.
3. The person's GitHub login is in `users`, and the Slack ID is correct.
4. `notifications.dm.enabled` isn't `false` for the org.
5. The Slack app has `chat:write` and the **Messages** tab on.
6. The person hasn't muted the bot's conversation.
7. The comment isn't from a bot, and isn't the author's own comment without a mention.
8. For a fork PR, the workflow has a `schedule` trigger, and enough time passed for the next run.

When a DM falls back to the thread and no reply appears, the PR was never routed, or someone muted the Slack message.
