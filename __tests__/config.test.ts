import { loadTeamsConfigForOrg, getLabelForTeam, getSlackChannel, parseTeamsConfig, humanizeSlug, fetchConfigFromRepo, fetchConfigFromS3 } from "../src/config";
import { OrgConfig } from "../src/types";

describe("loadTeamsConfigForOrg", () => {
  it("loads org-specific config section from bundled config", async () => {
    const config = await loadTeamsConfigForOrg("datarobot-oss");
    expect(config.teams["applications"].label).toBe("Needs Review: Applications");
    expect(config.teams["applications"]).toBeDefined();
  });

  it("loads different config for different org", async () => {
    const config = await loadTeamsConfigForOrg("datarobot-community");
    expect(config.teams["applications"]).toBeDefined();
    expect(config.teams["datarobot-agent-skills"]).toBeUndefined();
  });

  it("returns empty teams for unknown org", async () => {
    const config = await loadTeamsConfigForOrg("unknown-org");
    expect(config.teams).toEqual({});
  });
});

describe("parseTeamsConfig", () => {
  it("parses nested org structure", () => {
    const config = parseTeamsConfig(`
orgs:
  my-org:
    default_slack_channel: "#general"
    teams:
      foo:
        label: "L"
        slack_channel: "#foo"
`);
    expect(config.orgs["my-org"].default_slack_channel).toBe("#general");
    expect(config.orgs["my-org"].teams["foo"].slack_channel).toBe("#foo");
  });
});

describe("getLabelForTeam", () => {
  let config: OrgConfig;
  beforeAll(async () => {
    config = await loadTeamsConfigForOrg("datarobot-oss");
  });

  it("returns configured label for known team", () => {
    expect(getLabelForTeam(config, "applications", "Needs Review")).toBe(
      "Needs Review: Applications"
    );
  });

  it("generates humanized label from slug for unknown team", () => {
    expect(getLabelForTeam(config, "unknown-team", "Needs Review")).toBe(
      "Needs Review: Unknown Team"
    );
  });

  it("resolves -oss suffixed slug to base team config", () => {
    expect(getLabelForTeam(config, "applications-oss", "Needs Review")).toBe(
      "Needs Review: Applications"
    );
  });

});

describe("humanizeSlug", () => {
  it("capitalizes each word", () => {
    expect(humanizeSlug("core-modeling")).toBe("Core Modeling");
  });

  it("handles DataRobot as a special case", () => {
    expect(humanizeSlug("datarobot-agent-skills")).toBe("DataRobot Agent Skills");
  });

  it("handles single word", () => {
    expect(humanizeSlug("applications")).toBe("Applications");
  });
});

describe("fetchConfigFromRepo", () => {
  it("fetches and decodes teams.yml from a GitHub repo", async () => {
    const yamlContent = "orgs:\n  my-org:\n    teams:\n      foo:\n        label: L\n        slack_channel: '#foo'\n";
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockResolvedValue({
            data: { content: Buffer.from(yamlContent).toString("base64") },
          }),
        },
      },
    };
    const result = await fetchConfigFromRepo(mockOctokit as any, "owner/repo");
    expect(result).toBe(yamlContent);
    expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      path: "teams.yml",
      ref: "main",
    });
  });

  it("returns null for invalid repo format", async () => {
    const result = await fetchConfigFromRepo({} as any, "invalid");
    expect(result).toBeNull();
  });

  it("returns null when repo returns 404", async () => {
    const mockOctokit = {
      rest: { repos: { getContent: jest.fn().mockRejectedValue({ status: 404 }) } },
    };
    const result = await fetchConfigFromRepo(mockOctokit as any, "owner/repo");
    expect(result).toBeNull();
  });

  it("returns null on other API errors", async () => {
    const mockOctokit = {
      rest: { repos: { getContent: jest.fn().mockRejectedValue(new Error("Server Error")) } },
    };
    const result = await fetchConfigFromRepo(mockOctokit as any, "owner/repo");
    expect(result).toBeNull();
  });
});

describe("fetchConfigFromS3", () => {
  it("returns null for invalid S3 URI", async () => {
    const result = await fetchConfigFromS3("not-an-s3-uri");
    expect(result).toBeNull();
  });
});

describe("loadTeamsConfigForOrg with external config", () => {
  it("uses config-repo when provided", async () => {
    const yamlContent = "orgs:\n  test-org:\n    teams:\n      bar:\n        label: Bar\n        slack_channel: '#bar'\n";
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockResolvedValue({
            data: { content: Buffer.from(yamlContent).toString("base64") },
          }),
        },
      },
    };
    const config = await loadTeamsConfigForOrg("test-org", mockOctokit as any, "owner/config-repo");
    expect(config.teams["bar"].label).toBe("Bar");
  });

  it("falls back to bundled config when external config has no matching org", async () => {
    const yamlContent = "orgs:\n  other-org:\n    teams:\n      bar:\n        label: Bar\n        slack_channel: '#bar'\n";
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockResolvedValue({
            data: { content: Buffer.from(yamlContent).toString("base64") },
          }),
        },
      },
    };
    const config = await loadTeamsConfigForOrg("datarobot-oss", mockOctokit as any, "owner/config-repo");
    expect(config.teams["applications"]).toBeDefined();
  });

  it("falls back to bundled config when external YAML is malformed", async () => {
    const mockOctokit = {
      rest: {
        repos: {
          getContent: jest.fn().mockResolvedValue({
            data: { content: Buffer.from("not: [valid: yaml: {").toString("base64") },
          }),
        },
      },
    };
    const config = await loadTeamsConfigForOrg("datarobot-oss", mockOctokit as any, "owner/config-repo");
    expect(config.teams["applications"]).toBeDefined();
  });

  it("falls back to bundled config when repo fetch fails", async () => {
    const mockOctokit = {
      rest: { repos: { getContent: jest.fn().mockRejectedValue({ status: 404 }) } },
    };
    const config = await loadTeamsConfigForOrg("datarobot-oss", mockOctokit as any, "owner/missing-repo");
    expect(config.teams["applications"]).toBeDefined();
  });
});

describe("getSlackChannel", () => {
  it("returns team-specific channel when configured", () => {
    const config: OrgConfig = {
      teams: { foo: { label: "L", slack_channel: "#foo-reviews" } },
    };
    expect(getSlackChannel(config, "foo")).toBe("#foo-reviews");
  });

  it("falls back to default_slack_channel for unconfigured team", () => {
    const config: OrgConfig = {
      default_slack_channel: "#default",
      teams: { foo: { label: "L", slack_channel: "#foo" } },
    };
    expect(getSlackChannel(config, "unknown-team")).toBe("#default");
  });

  it("skips notification when channel is empty string", () => {
    const config: OrgConfig = {
      teams: { foo: { label: "L", slack_channel: "" } },
    };
    expect(getSlackChannel(config, "foo")).toBe("");
  });

  it("returns undefined when no default and no team config", () => {
    const config = { teams: {} };
    expect(getSlackChannel(config, "unknown-team")).toBeUndefined();
  });

  it("resolves -oss suffixed slug to base team channel", () => {
    const config: OrgConfig = {
      teams: { foo: { label: "L", slack_channel: "#foo-reviews" } },
    };
    expect(getSlackChannel(config, "foo-oss")).toBe("#foo-reviews");
  });
});
