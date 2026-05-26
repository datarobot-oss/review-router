import * as fs from "fs";
import * as yaml from "js-yaml";
import * as core from "@actions/core";
import { TeamsConfig } from "./types";

export function loadTeamsConfig(configPath: string): TeamsConfig {
  try {
    const content = fs.readFileSync(configPath, "utf8");
    const parsed = yaml.load(content) as TeamsConfig;
    return parsed && parsed.teams ? parsed : { teams: {} };
  } catch {
    core.warning(`Could not load teams config from ${configPath}`);
    return { teams: {} };
  }
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
  return config.teams[teamSlug]?.slack_channel;
}
