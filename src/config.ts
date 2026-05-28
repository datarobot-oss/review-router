import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import * as core from "@actions/core";
import { TeamsConfig, OrgConfig } from "./types";

export function parseTeamsConfig(content: string): TeamsConfig {
  const parsed = yaml.load(content) as TeamsConfig;
  return parsed && parsed.orgs ? parsed : { orgs: {} };
}

export function loadTeamsConfigForOrg(org: string): OrgConfig {
  const configPath = path.join(__dirname, "..", "config", "teams.yml");
  try {
    const content = fs.readFileSync(configPath, "utf8");
    const config = parseTeamsConfig(content);
    const orgConfig = config.orgs[org];
    if (orgConfig) {
      core.info(`Loaded team config for org "${org}"`);
      return orgConfig;
    }
    core.warning(`No config section found for org "${org}" in teams.yml`);
  } catch {
    core.warning(`Could not load teams config from ${configPath}`);
  }
  return { teams: {} };
}

export function getLabelForTeam(
  config: OrgConfig,
  teamSlug: string,
  prefix: string
): string {
  const teamConfig = config.teams[teamSlug];
  if (teamConfig) {
    return teamConfig.label;
  }
  return `${prefix}: ${humanizeSlug(teamSlug)}`;
}

export function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .map((word) => {
      if (word.toLowerCase() === "datarobot") return "DataRobot";
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

export function getSlackChannel(
  config: OrgConfig,
  teamSlug: string
): string | undefined {
  return config.teams[teamSlug]?.slack_channel ?? config.default_slack_channel;
}
