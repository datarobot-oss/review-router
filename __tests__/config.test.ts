import { loadTeamsConfigForOrg, getLabelForTeam, getSlackChannel, parseTeamsConfig, humanizeSlug } from "../src/config";
import { OrgConfig } from "../src/types";

describe("loadTeamsConfigForOrg", () => {
  it("loads org-specific config section", () => {
    const config = loadTeamsConfigForOrg("datarobot-oss");
    expect(config.teams["applications"]).toEqual({
      label: "Needs Review: Applications",
      slack_channel: "",
    });
  });

  it("loads different config for different org", () => {
    const config = loadTeamsConfigForOrg("datarobot-community");
    expect(config.teams["customer-engineering"]).toBeDefined();
    expect(config.teams["datarobot-agent-skills"]).toBeUndefined();
  });

  it("returns empty teams for unknown org", () => {
    const config = loadTeamsConfigForOrg("unknown-org");
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
  const config = loadTeamsConfigForOrg("datarobot-oss");

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
});
