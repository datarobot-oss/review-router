import { loadTeamsConfig, getLabelForTeam } from "../src/config";
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
