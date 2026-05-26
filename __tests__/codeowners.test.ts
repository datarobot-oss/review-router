import { parseCodeowners, mapFilesToTeams } from "../src/codeowners";
import * as fs from "fs";
import * as path from "path";

const fixtureContent = fs.readFileSync(
  path.join(__dirname, "fixtures", "CODEOWNERS"),
  "utf8"
);

describe("parseCodeowners", () => {
  it("parses CODEOWNERS content into entries", () => {
    const entries = parseCodeowners(fixtureContent);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toHaveProperty("pattern");
    expect(entries[0]).toHaveProperty("owners");
  });
});

describe("mapFilesToTeams", () => {
  const entries = parseCodeowners(fixtureContent);
  const orgPrefix = "datarobot-community";

  it("maps files to their owning teams", () => {
    const result = mapFilesToTeams(
      ["src/app.py", "infra/main.tf"],
      entries,
      orgPrefix
    );
    expect(result.teamFiles.get("customer-engineering")).toContain("src/app.py");
    expect(result.teamFiles.get("platform-team")).toContain("infra/main.tf");
  });

  it("filters out individual user owners", () => {
    const result = mapFilesToTeams(["docs/readme.md"], entries, orgPrefix);
    const allTeams = Array.from(result.teamFiles.keys());
    expect(allTeams).not.toContain("johndoe");
  });

  it("reports unowned files (only individual owners)", () => {
    const result = mapFilesToTeams(["docs/readme.md"], entries, orgPrefix);
    expect(result.unownedFiles).toContain("docs/readme.md");
  });

  it("handles files with multiple team owners", () => {
    const result = mapFilesToTeams(["src/shared/utils.ts"], entries, orgPrefix);
    expect(result.teamFiles.get("customer-engineering")).toContain(
      "src/shared/utils.ts"
    );
    expect(result.teamFiles.get("platform-team")).toContain(
      "src/shared/utils.ts"
    );
  });

  it("returns empty maps for empty file list", () => {
    const result = mapFilesToTeams([], entries, orgPrefix);
    expect(result.teamFiles.size).toBe(0);
    expect(result.unownedFiles).toHaveLength(0);
  });
});
