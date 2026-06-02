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

  it("maps files to their owning teams", () => {
    const result = mapFilesToTeams(["src/app.py", "infra/main.tf"], entries);
    expect(result.teamFiles.get("customer-engineering")).toContain("src/app.py");
    expect(result.teamFiles.get("platform-team")).toContain("infra/main.tf");
  });

  it("filters out individual user owners", () => {
    const result = mapFilesToTeams(["docs/readme.md"], entries);
    const allTeams = Array.from(result.teamFiles.keys());
    expect(allTeams).not.toContain("johndoe");
  });

  it("falls back to default team when file has only individual owners", () => {
    const result = mapFilesToTeams(["docs/readme.md"], entries);
    expect(result.teamFiles.get("customer-engineering")).toContain("docs/readme.md");
    expect(result.unownedFiles).not.toContain("docs/readme.md");
  });

  it("reports unowned files when no CODEOWNERS pattern matches", () => {
    const noDefaultEntries = parseCodeowners(
      "/src/ @datarobot-community/platform-team\n"
    );
    const result = mapFilesToTeams(["unmatched/file.txt"], noDefaultEntries);
    expect(result.unownedFiles).toContain("unmatched/file.txt");
  });

  it("reports unowned files when default owner is also an individual", () => {
    const individualDefaultEntries = parseCodeowners(
      "* @johndoe\ndocs/ @janedoe\n"
    );
    const result = mapFilesToTeams(["docs/readme.md"], individualDefaultEntries);
    expect(result.unownedFiles).toContain("docs/readme.md");
  });

  it("handles files with multiple team owners", () => {
    const result = mapFilesToTeams(["src/shared/utils.ts"], entries);
    expect(result.teamFiles.get("customer-engineering")).toContain(
      "src/shared/utils.ts"
    );
    expect(result.teamFiles.get("platform-team")).toContain(
      "src/shared/utils.ts"
    );
  });

  it("returns empty maps for empty file list", () => {
    const result = mapFilesToTeams([], entries);
    expect(result.teamFiles.size).toBe(0);
    expect(result.unownedFiles).toHaveLength(0);
  });

  it("matches glob patterns in directory names", () => {
    const globEntries = parseCodeowners(
      "* @org/default\n/skills/datarobot-app-framework-*/ @org/applications\n"
    );
    const result = mapFilesToTeams(
      ["skills/datarobot-app-framework-cicd/README.md"],
      globEntries
    );
    expect(result.teamFiles.get("applications")).toContain(
      "skills/datarobot-app-framework-cicd/README.md"
    );
    expect(result.teamFiles.has("default")).toBe(false);
  });

  it("extracts team slugs from any org prefix", () => {
    const multiOrgEntries = parseCodeowners(
      "* @datarobot-oss/team-a\n/infra/ @datarobot/team-b\n"
    );
    const result = mapFilesToTeams(
      ["src/app.py", "infra/main.tf"],
      multiOrgEntries
    );
    expect(result.teamFiles.get("team-a")).toContain("src/app.py");
    expect(result.teamFiles.get("team-b")).toContain("infra/main.tf");
  });
});
