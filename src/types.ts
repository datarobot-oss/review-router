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

export interface OrgConfig {
  default_slack_channel?: string;
  reminders?: RemindersConfig;
  dependabot?: DependabotConfig;
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
  configS3: string;
  readyLabel: string;
  needsReviewPrefix: string;
  needsReviewLabelColor: string;
}

export interface Capabilities {
  hasOrgAccess: boolean;
}
