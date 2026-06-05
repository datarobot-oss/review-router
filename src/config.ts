import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import * as core from "@actions/core";
import Ajv from "ajv";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { TeamsConfig, OrgConfig, TeamConfig, Octokit } from "./types";

const configSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config", "schema.json"), "utf8")
);
const ajv = new Ajv();
const validateConfig = ajv.compile(configSchema);

export function parseTeamsConfig(content: string): TeamsConfig {
  const parsed = yaml.load(content);
  if (!validateConfig(parsed)) {
    const errors = validateConfig.errors?.map((e) => `${e.instancePath} ${e.message}`).join("; ");
    throw new Error(`Config validation failed: ${errors}`);
  }
  return parsed as TeamsConfig;
}

function loadBundledConfig(org: string): OrgConfig {
  const configPath = path.join(__dirname, "..", "config", "teams.yml");
  try {
    const content = fs.readFileSync(configPath, "utf8");
    const config = parseTeamsConfig(content);
    const orgConfig = config.orgs[org];
    if (orgConfig) {
      core.info(`Loaded team config for org "${org}" from bundled config`);
      return orgConfig;
    }
    core.warning(`No config section found for org "${org}" in bundled teams.yml`);
  } catch {
    core.warning(`Could not load bundled teams config from ${configPath}`);
  }
  return { teams: {} };
}

export async function fetchConfigFromRepo(
  octokit: Octokit,
  configRepo: string
): Promise<string | null> {
  const [owner, repo] = configRepo.split("/");
  if (!owner || !repo) {
    core.warning(`Invalid config-repo format: "${configRepo}" (expected "owner/repo")`);
    return null;
  }
  try {
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    const ref = repoData.default_branch;
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: "teams.yml",
      ref,
    });
    if ("content" in response.data && response.data.content) {
      core.info(`Fetched config from ${configRepo}/teams.yml`);
      return Buffer.from(response.data.content, "base64").toString("utf8");
    }
    return null;
  } catch (error: unknown) {
    const httpError = error as { status?: number };
    if (httpError.status === 404) {
      core.warning(`No teams.yml found in ${configRepo}`);
    } else {
      core.warning(
        `Failed to fetch config from ${configRepo}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return null;
  }
}

export async function fetchConfigFromS3(s3Uri: string): Promise<string | null> {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    core.warning(`Invalid config-s3 format: "${s3Uri}" (expected "s3://bucket/key")`);
    return null;
  }
  const [, bucket, key] = match;
  try {
    const client = new S3Client({});
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const content = await response.Body?.transformToString();
    if (content) {
      core.info(`Fetched config from ${s3Uri}`);
      return content;
    }
    return null;
  } catch (error) {
    core.warning(
      `Failed to fetch config from S3 (${s3Uri}): ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export async function loadTeamsConfigForOrg(
  org: string,
  octokit?: Octokit,
  configRepo?: string,
  configToken?: string,
  configS3?: string
): Promise<OrgConfig> {
  let content: string | null = null;

  if (configRepo && octokit) {
    const configOctokit = configToken
      ? (await import("@actions/github")).getOctokit(configToken)
      : octokit;
    content = await fetchConfigFromRepo(configOctokit, configRepo);
  }
  if (!content && configS3) {
    content = await fetchConfigFromS3(configS3);
  }

  if (content) {
    try {
      const config = parseTeamsConfig(content);
      const orgConfig = config.orgs[org];
      if (orgConfig) {
        core.info(`Loaded team config for org "${org}"`);
        return orgConfig;
      }
      core.warning(`No config section found for org "${org}" in external config`);
    } catch (error) {
      core.warning(
        `Failed to parse external config: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return loadBundledConfig(org);
}

function resolveTeamConfig(config: OrgConfig, teamSlug: string): TeamConfig | undefined {
  if (config.teams[teamSlug]) return config.teams[teamSlug];
  if (teamSlug.endsWith("-oss")) return config.teams[teamSlug.slice(0, -4)];
  return undefined;
}

export function getLabelForTeam(
  config: OrgConfig,
  teamSlug: string,
  prefix: string
): string {
  const teamConfig = resolveTeamConfig(config, teamSlug);
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
  return resolveTeamConfig(config, teamSlug)?.slack_channel ?? config.default_slack_channel;
}
