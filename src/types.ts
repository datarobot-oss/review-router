export interface TeamConfig {
  label: string;
  slack_channel: string;
}

export interface TeamsConfig {
  teams: Record<string, TeamConfig>;
  default_slack_channel?: string;
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
