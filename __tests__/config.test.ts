import { loadTeamsConfigForOrg, getLabelForTeam, getSlackChannel, parseTeamsConfig } from "../src/config";

describe("loadTeamsConfigForOrg", () => {
  it("loads org-specific config when it exists", () => {
    const config = loadTeamsConfigForOrg("datarobot-oss");
    expect(config.teams["applications"]).toEqual({
      label: "Needs Review: Applications",
      slack_channel: "#applications-spam",
    });
  });

  it("falls back to teams.yml for unknown org", () => {
    const config = loadTeamsConfigForOrg("unknown-org");
    expect(config.teams["applications"]).toBeDefined();
  });

  it("falls back to teams.yml for org with no specific config", () => {
    const config = loadTeamsConfigForOrg("some-random-org-with-no-config");
    expect(config.teams).toBeDefined();
    expect(config.teams["applications"]).toBeDefined();
  });
});

describe("parseTeamsConfig", () => {
  it("parses default_slack_channel", () => {
    const config = parseTeamsConfig(
      'default_slack_channel: "#general"\nteams:\n  foo:\n    label: "L"\n    slack_channel: "#foo"'
    );
    expect(config.default_slack_channel).toBe("#general");
    expect(config.teams["foo"].slack_channel).toBe("#foo");
  });
});

describe("getLabelForTeam", () => {
  const config = loadTeamsConfigForOrg("datarobot-oss");

  it("returns configured label for known team", () => {
    expect(getLabelForTeam(config, "applications", "Needs Review")).toBe(
      "Needs Review: Applications"
    );
  });

  it("generates label from slug for unknown team", () => {
    expect(getLabelForTeam(config, "unknown-team", "Needs Review")).toBe(
      "Needs Review: unknown-team"
    );
  });
});

describe("getSlackChannel", () => {
  it("returns team-specific channel when configured", () => {
    const config = parseTeamsConfig(
      'default_slack_channel: "#default"\nteams:\n  foo:\n    label: "L"\n    slack_channel: "#foo-reviews"'
    );
    expect(getSlackChannel(config, "foo")).toBe("#foo-reviews");
  });

  it("falls back to default_slack_channel for unconfigured team", () => {
    const config = parseTeamsConfig(
      'default_slack_channel: "#default"\nteams:\n  foo:\n    label: "L"\n    slack_channel: "#foo"'
    );
    expect(getSlackChannel(config, "unknown-team")).toBe("#default");
  });

  it("returns undefined when no default and no team config", () => {
    const config = parseTeamsConfig('teams:\n  foo:\n    label: "L"\n    slack_channel: "#foo"');
    expect(getSlackChannel(config, "unknown-team")).toBeUndefined();
  });
});
