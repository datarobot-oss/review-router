import { loadTeamsConfig, getLabelForTeam, getSlackChannel, parseTeamsConfig } from "../src/config";
import * as path from "path";

const fixtureDir = path.join(__dirname, "fixtures");

describe("loadTeamsConfig", () => {
  it("parses teams.yml into TeamsConfig", () => {
    const config = loadTeamsConfig(path.join(fixtureDir, "teams.yml"));
    expect(config.teams["customer-engineering"]).toEqual({
      label: "Needs Review: Customer Engineering",
      slack_channel: "#app-templates-tests",
    });
    expect(config.teams["platform-team"]).toEqual({
      label: "Needs Review: Platform",
      slack_channel: "#platform-reviews",
    });
  });

  it("returns empty teams map for missing file", () => {
    const config = loadTeamsConfig("/nonexistent/path/teams.yml");
    expect(config.teams).toEqual({});
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
  const config = loadTeamsConfig(path.join(fixtureDir, "teams.yml"));

  it("returns configured label for known team", () => {
    expect(getLabelForTeam(config, "customer-engineering", "Needs Review")).toBe(
      "Needs Review: Customer Engineering"
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
