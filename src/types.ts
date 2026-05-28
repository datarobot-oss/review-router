export interface TeamConfig {
  label: string;
  slack_channel: string;
}

export interface OrgConfig {
  default_slack_channel?: string;
  teams: Record<string, TeamConfig>;
}

export interface TeamsConfig {
  orgs: Record<string, OrgConfig>;
}

export interface OwnershipMap {
  teamFiles: Map<string, string[]>;
  unownedFiles: string[];
}

export interface ActionInputs {
  githubToken: string;
  slackToken: string;
  readyLabel: string;
  needsReviewPrefix: string;
  needsReviewLabelColor: string;
}

export interface Capabilities {
  hasOrgAccess: boolean;
}
