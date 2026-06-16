export interface TeamConfig {
  label: string;
  slack_channel: string;
}

export interface RemindersConfig {
  enabled: boolean;
  stale_hours?: number;
}

export interface DependabotConfig {
  auto_label: boolean;
}

export interface ExternalContributorsConfig {
  auto_label: boolean;
  message?: string;
}

export interface NotificationIcons {
  header?: string;
  branch?: string;
  commits?: string;
  files?: string;
  labels?: string;
}

export interface ReactionsConfig {
  enabled: boolean;
  approved?: string;
  merged?: string;
  closed?: string;
  icons?: NotificationIcons;
  file_types?: Record<string, string>;
}

export interface OrgConfig {
  default_slack_channel?: string;
  ready_label_aliases?: string[];
  reminders?: RemindersConfig;
  dependabot?: DependabotConfig;
  external_contributors?: ExternalContributorsConfig;
  reactions?: ReactionsConfig;
  teams: Record<string, TeamConfig>;
  users?: Record<string, string>;
}

export interface TeamsConfig {
  orgs: Record<string, OrgConfig>;
  users?: Record<string, string>;
}

export interface OwnershipMap {
  teamFiles: Map<string, string[]>;
  unownedFiles: string[];
  defaultedFiles: Map<string, string[]>;
}

export type Octokit = ReturnType<typeof import("@actions/github").getOctokit>;

export interface ActionInputs {
  githubToken: string;
  slackToken: string;
  configRepo: string;
  configToken: string;
  configPath: string;
  configS3: string;
  readyLabel: string;
  needsReviewPrefix: string;
  needsReviewLabelColor: string;
}

export interface Capabilities {
  hasOrgAccess: boolean;
}

export interface CommentContext {
  owner: string;
  repo: string;
  prNumber: number;
  prBody: string;
  prUrl: string;
  author: string;
  commenter: string;
  commentUrl: string;
  assignees: string[];
  kind: "comment" | "review" | "review_comment";
  inputs: ActionInputs;
  teamsConfig: OrgConfig;
}
