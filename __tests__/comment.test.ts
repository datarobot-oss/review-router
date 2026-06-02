import { buildOwnershipComment, upsertComment, COMMENT_MARKER } from "../src/comment";

describe("buildOwnershipComment", () => {
  it("builds a comment with team ownership list", () => {
    const teamFiles = new Map<string, string[]>();
    teamFiles.set("customer-engineering", ["src/app.py", "src/utils.py"]);
    teamFiles.set("platform-team", ["infra/main.tf"]);
    const comment = buildOwnershipComment({ teamFiles, unownedFiles: [], defaultedFiles: new Map() }, true);
    expect(comment).toContain(COMMENT_MARKER);
    expect(comment).toContain("## Code Ownership");
    expect(comment).toContain("**Customer Engineering**");
    expect(comment).toContain("- `src/app.py`");
    expect(comment).toContain("- `src/utils.py`");
    expect(comment).toContain("**Platform Team**");
    expect(comment).toContain("- `infra/main.tf`");
    expect(comment).not.toContain("Unowned files");
  });

  it("includes unowned files section when present", () => {
    const teamFiles = new Map<string, string[]>();
    teamFiles.set("customer-engineering", ["src/app.py"]);
    const comment = buildOwnershipComment({ teamFiles, unownedFiles: ["docs/README.md", "scripts/setup.sh"], defaultedFiles: new Map() }, true);
    expect(comment).toContain("Unowned files");
    expect(comment).toContain("docs/README.md");
    expect(comment).toContain("scripts/setup.sh");
  });

  it("handles empty ownership map", () => {
    const comment = buildOwnershipComment({ teamFiles: new Map(), unownedFiles: ["file.txt"], defaultedFiles: new Map() }, true);
    expect(comment).toContain(COMMENT_MARKER);
    expect(comment).toContain("file.txt");
  });

  it("includes auto-removal note when hasOrgAccess is true", () => {
    const comment = buildOwnershipComment({ teamFiles: new Map(), unownedFiles: [], defaultedFiles: new Map() }, true);
    expect(comment).toContain("Labels will be removed automatically upon approval");
  });

  it("annotates defaulted files with original owners", () => {
    const teamFiles = new Map<string, string[]>();
    teamFiles.set("customer-engineering", ["src/app.py", "docs/readme.md"]);
    const defaultedFiles = new Map<string, string[]>();
    defaultedFiles.set("docs/readme.md", ["@johndoe"]);
    const comment = buildOwnershipComment({ teamFiles, unownedFiles: [], defaultedFiles }, true);
    expect(comment).toContain("- `src/app.py`");
    expect(comment).toContain("- `docs/readme.md` _(default — owned by @johndoe)_");
  });

  it("omits auto-removal note when hasOrgAccess is false", () => {
    const comment = buildOwnershipComment({ teamFiles: new Map(), unownedFiles: [], defaultedFiles: new Map() }, false);
    expect(comment).not.toContain("Labels will be removed automatically");
    expect(comment).toContain("Review requested from the teams above.");
  });
});

describe("upsertComment", () => {
  const mockOctokit = {
    rest: { issues: { listComments: jest.fn(), createComment: jest.fn(), updateComment: jest.fn() } },
  };
  beforeEach(() => jest.clearAllMocks());

  it("creates a new comment when none exists", async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    mockOctokit.rest.issues.createComment.mockResolvedValue({});
    await upsertComment(mockOctokit as any, "owner", "repo", 1, "body");
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({ owner: "owner", repo: "repo", issue_number: 1, body: "body" });
  });

  it("updates existing comment when marker is found", async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [{ id: 42, body: `${COMMENT_MARKER}\nold content` }] });
    mockOctokit.rest.issues.updateComment.mockResolvedValue({});
    await upsertComment(mockOctokit as any, "owner", "repo", 1, `${COMMENT_MARKER}\nnew`);
    expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith({ owner: "owner", repo: "repo", comment_id: 42, body: `${COMMENT_MARKER}\nnew` });
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });
});
