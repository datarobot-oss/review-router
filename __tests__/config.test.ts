import {
  loadTeamsConfigForOrg,
  getLabelForTeam,
  getSlackChannel,
  parseTeamsConfig,
  humanizeSlug,
  fetchConfigFromRepo,
  fetchConfigFromS3,
} from "../src/config";
import { OrgConfig } from "../src/types";

describe("loadTeamsConfigForOrg", () => {
  it("loads org-specific config section from bundled config", async () => {
    const config = await loadTeamsConfigForOrg("acme-corp");
    expect(config.teams["frontend"].label).toBe("Needs Review: Frontend");
    expect(config.teams["backend"]).toBeDefined();
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

  it("throws on config missing required fields", () => {
    expect(() =>
      parseTeamsConfig(`
orgs:
  my-org:
    teams:
      foo:
        label: "L"
`)
    ).toThrow("Config validation failed");
  });

  it("throws on config with unexpected fields", () => {
    expect(() =>
      parseTeamsConfig(`
orgs:
  my-org:
    teams:
      foo:
        label: "L"
        slack_channel: "#foo"
        unknown_field: "x"
`)
    ).toThrow("Config validation failed");
  });

  it("accepts config with reminders enabled", () => {
    const config = parseTeamsConfig(`
orgs:
  my-org:
    reminders:
      enabled: true
      stale_hours: 48
    teams:
      foo:
        label: "L"
        slack_channel: "#foo"
`);
    expect(config.orgs["my-org"].reminders?.enabled).toBe(true);
    expect(config.orgs["my-org"].reminders?.stale_hours).toBe(48);
  });

  it("accepts config with dependabot auto_label", () => {
    const config = parseTeamsConfig(`
orgs:
  my-org:
    dependabot:
      auto_label: true
    teams:
      foo:
        label: "L"
        slack_channel: "#foo"
`);
    expect(config.orgs["my-org"].dependabot?.auto_label).toBe(true);
  });

  it("accepts config with both features", () => {
    const config = parseTeamsConfig(`
orgs:
  my-org:
    reminders:
      enabled: true
    dependabot:
      auto_label: true
    teams:
      foo:
        label: "L"
        slack_channel: "#foo"
`);
    expect(config.orgs["my-org"].reminders?.enabled).toBe(true);
    expect(config.orgs["my-org"].dependabot?.auto_label).toBe(true);
  });

  it("accepts config with jira enabled", () => {
    const config = parseTeamsConfig(`
orgs:
  my-org:
    jira:
      enabled: true
      base_url: "https://acme.atlassian.net"
    teams:
      foo:
        label: "L"
        slack_channel: "#foo"
`);
    expect(config.orgs["my-org"].jira?.enabled).toBe(true);
    expect(config.orgs["my-org"].jira?.base_url).toBe("https://acme.atlassian.net");
  });

  it("rejects unknown fields in jira", () => {
    expect(() =>
      parseTeamsConfig(`
orgs:
  my-org:
    jira:
      enabled: true
      auth_type: bearer
    teams:
      foo:
        label: "L"
        slack_channel: "#foo"
`)
    ).toThrow(/Config validation failed/);
  });

  it("rejects invalid stale_hours", () => {
    expect(() =>
      parseTeamsConfig(`
orgs:
  my-org:
    reminders:
      enabled: true
      stale_hours: 0
    teams:
      foo:
        label: "L"
        slack_channel: "#foo"
`)
    ).toThrow("Config validation failed");
  });

  it("rejects unknown fields in reminders", () => {
    expect(() =>
      parseTeamsConfig(`
orgs:
  my-org:
    reminders:
      enabled: true
      unknown: true
    teams:
      foo:
        label: "L"
        slack_channel: "#foo"
`)
    ).toThrow("Config validation failed");
  });

  it("rejects unknown fields in dependabot", () => {
    expect(() =>
      parseTeamsConfig(`
orgs:
  my-org:
    dependabot:
      auto_label: true
      unknown: true
    teams:
      foo:
        label: "L"
        slack_channel: "#foo"
`)
    ).toThrow("Config validation failed");
  });

  it("accepts external_contributors config", () => {
    const config = parseTeamsConfig(`
orgs:
  my-org:
    external_contributors:
      auto_label: true
    teams:
      foo:
        label: "L"
        slack_channel: "#foo"
`);
    expect(config.orgs["my-org"].external_contributors?.auto_label).toBe(true);
  });

  it("rejects invalid external_contributors config", () => {
    expect(() =>
      parseTeamsConfig(`
orgs:
  my-org:
    external_contributors:
      auto_label: "yes"
    teams:
      foo:
        label: "L"
        slack_channel: "#foo"
`)
    ).toThrow("Config validation failed");
  });
});

describe("getLabelForTeam", () => {
  let config: OrgConfig;
  beforeAll(async () => {
    config = await loadTeamsConfigForOrg("acme-corp");
  });

  it("returns configured label for known team", () => {
    expect(getLabelForTeam(config, "frontend", "Needs Review")).toBe("Needs Review: Frontend");
  });

  it("generates humanized label from slug for unknown team", () => {
    expect(getLabelForTeam(config, "unknown-team", "Needs Review")).toBe(
      "Needs Review: Unknown Team"
    );
  });

  it("resolves -oss suffixed slug to base team config", () => {
    expect(getLabelForTeam(config, "frontend-oss", "Needs Review")).toBe("Needs Review: Frontend");
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
  const mockReposGet = jest.fn().mockResolvedValue({ data: { default_branch: "main" } });

  it("fetches and decodes config.yml from a GitHub repo", async () => {
    const yamlContent =
      "orgs:\n  my-org:\n    teams:\n      foo:\n        label: L\n        slack_channel: '#foo'\n";
    const mockOctokit = {
      rest: {
        repos: {
          get: mockReposGet,
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
      path: "config.yml",
      ref: "main",
    });
  });

  it("uses the repo default branch, not hardcoded main", async () => {
    const yamlContent =
      "orgs:\n  my-org:\n    teams:\n      foo:\n        label: L\n        slack_channel: '#foo'\n";
    const mockOctokit = {
      rest: {
        repos: {
          get: jest.fn().mockResolvedValue({ data: { default_branch: "develop" } }),
          getContent: jest.fn().mockResolvedValue({
            data: { content: Buffer.from(yamlContent).toString("base64") },
          }),
        },
      },
    };
    await fetchConfigFromRepo(mockOctokit as any, "owner/repo");
    expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "develop" })
    );
  });

  it("returns null for invalid repo format", async () => {
    const result = await fetchConfigFromRepo({} as any, "invalid");
    expect(result).toBeNull();
  });

  it("returns null when repo returns 404", async () => {
    const mockOctokit = {
      rest: {
        repos: { get: mockReposGet, getContent: jest.fn().mockRejectedValue({ status: 404 }) },
      },
    };
    const result = await fetchConfigFromRepo(mockOctokit as any, "owner/repo");
    expect(result).toBeNull();
  });

  it("returns null on other API errors", async () => {
    const mockOctokit = {
      rest: {
        repos: {
          get: mockReposGet,
          getContent: jest.fn().mockRejectedValue(new Error("Server Error")),
        },
      },
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
  const mockReposGet = jest.fn().mockResolvedValue({ data: { default_branch: "main" } });

  it("uses config-repo when provided", async () => {
    const yamlContent =
      "orgs:\n  test-org:\n    teams:\n      bar:\n        label: Bar\n        slack_channel: '#bar'\n";
    const mockOctokit = {
      rest: {
        repos: {
          get: mockReposGet,
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
    const yamlContent =
      "orgs:\n  other-org:\n    teams:\n      bar:\n        label: Bar\n        slack_channel: '#bar'\n";
    const mockOctokit = {
      rest: {
        repos: {
          get: mockReposGet,
          getContent: jest.fn().mockResolvedValue({
            data: { content: Buffer.from(yamlContent).toString("base64") },
          }),
        },
      },
    };
    const config = await loadTeamsConfigForOrg(
      "acme-corp",
      mockOctokit as any,
      "owner/config-repo"
    );
    expect(config.teams["frontend"]).toBeDefined();
  });

  it("falls back to bundled config when external YAML is malformed", async () => {
    const mockOctokit = {
      rest: {
        repos: {
          get: mockReposGet,
          getContent: jest.fn().mockResolvedValue({
            data: { content: Buffer.from("not: [valid: yaml: {").toString("base64") },
          }),
        },
      },
    };
    const config = await loadTeamsConfigForOrg(
      "acme-corp",
      mockOctokit as any,
      "owner/config-repo"
    );
    expect(config.teams["frontend"]).toBeDefined();
  });

  it("falls back to bundled config when repo fetch fails", async () => {
    const mockOctokit = {
      rest: {
        repos: { get: mockReposGet, getContent: jest.fn().mockRejectedValue({ status: 404 }) },
      },
    };
    const config = await loadTeamsConfigForOrg(
      "acme-corp",
      mockOctokit as any,
      "owner/missing-repo"
    );
    expect(config.teams["frontend"]).toBeDefined();
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
