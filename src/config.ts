import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import * as core from "@actions/core";
import { TeamsConfig } from "./types";

export function parseTeamsConfig(content: string): TeamsConfig {
  const parsed = yaml.load(content) as TeamsConfig;
  return parsed && parsed.teams ? parsed : { teams: {} };
}

export function loadTeamsConfigForOrg(org: string): TeamsConfig {
  const orgConfigPath = path.join(__dirname, "..", "config", `teams-${org}.yml`);
  const fallbackPath = path.join(__dirname, "..", "config", "teams.yml");

  for (const configPath of [orgConfigPath, fallbackPath]) {
    try {
      const content = fs.readFileSync(configPath, "utf8");
      core.info(`Loaded team config from ${path.basename(configPath)}`);
      return parseTeamsConfig(content);
    } catch {
      continue;
    }
  }

  core.warning(`No team config found for org "${org}"`);
  return { teams: {} };
}

export function getLabelForTeam(
  config: TeamsConfig,
  teamSlug: string,
  prefix: string
): string {
  const teamConfig = config.teams[teamSlug];
  if (teamConfig) {
    return teamConfig.label;
  }
  return `${prefix}: ${teamSlug}`;
}

export function getSlackChannel(
  config: TeamsConfig,
  teamSlug: string
): string | undefined {
  return config.teams[teamSlug]?.slack_channel ?? config.default_slack_channel;
}
