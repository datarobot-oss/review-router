import * as fs from "fs";
import * as yaml from "js-yaml";
import * as core from "@actions/core";
import { TeamsConfig } from "./types";

const ORG_CONFIG_PATH = "review-router/teams.yml";

export function parseTeamsConfig(content: string): TeamsConfig {
  const parsed = yaml.load(content) as TeamsConfig;
  return parsed && parsed.teams ? parsed : { teams: {} };
}

export function loadTeamsConfig(configPath: string): TeamsConfig {
  try {
    const content = fs.readFileSync(configPath, "utf8");
    return parseTeamsConfig(content);
  } catch {
    core.warning(`Could not load teams config from ${configPath}`);
    return { teams: {} };
  }
}

export async function fetchOrgTeamsConfig(
  octokit: ReturnType<typeof import("@actions/github").getOctokit>,
  org: string
): Promise<TeamsConfig | null> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner: org,
      repo: ".github",
      path: ORG_CONFIG_PATH,
    });
    if ("content" in response.data && response.data.content) {
      const content = Buffer.from(response.data.content, "base64").toString("utf8");
      core.info(`Loaded team config from ${org}/.github/${ORG_CONFIG_PATH}`);
      return parseTeamsConfig(content);
    }
    return null;
  } catch {
    core.debug(`No org-level team config found at ${org}/.github/${ORG_CONFIG_PATH}`);
    return null;
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
  return config.teams[teamSlug]?.slack_channel ?? config.default_slack_channel;
}
