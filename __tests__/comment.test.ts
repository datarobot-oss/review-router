import {
  buildOwnershipComment,
  upsertComment,
  embedSlackRefs,
  extractSlackRefs,
  embedSlackRefsInDescription,
  extractSlackRefsFromDescription,
  postExternalComment,
  COMMENT_MARKER,
  EXTERNAL_COMMENT_MARKER,
} from "../src/comment";

jest.mock("@actions/core");

/** Returns an octokit whose paginate yields firstPage from listComments, then the rest. */
function commentsOctokit(firstPage: object[], rest: object[] = []) {
  const listComments = jest.fn(async () => ({ data: firstPage }));
  return {
    rest: { issues: { listComments, createComment: jest.fn(), updateComment: jest.fn() } },
    paginate: jest.fn(async () => [...firstPage, ...rest]),
  };
}

const chatter = Array.from({ length: 30 }, (_, i) => ({ id: i, body: "chatter" }));

describe("buildOwnershipComment", () => {
  it("builds a comment with team ownership list", () => {
    const teamFiles = new Map<string, string[]>();
    teamFiles.set("customer-engineering", ["src/app.py", "src/utils.py"]);
    teamFiles.set("platform-team", ["infra/main.tf"]);
    const comment = buildOwnershipComment(
      { teamFiles, unownedFiles: [], defaultedFiles: new Map() },
      true
    );
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
    const comment = buildOwnershipComment(
      {
        teamFiles,
        unownedFiles: ["docs/README.md", "scripts/setup.sh"],
        defaultedFiles: new Map(),
      },
      true
    );
    expect(comment).toContain("Unowned files");
    expect(comment).toContain("docs/README.md");
    expect(comment).toContain("scripts/setup.sh");
  });

  it("handles empty ownership map", () => {
    const comment = buildOwnershipComment(
      { teamFiles: new Map(), unownedFiles: ["file.txt"], defaultedFiles: new Map() },
      true
    );
    expect(comment).toContain(COMMENT_MARKER);
    expect(comment).toContain("file.txt");
  });

  it("includes auto-removal note when hasOrgAccess is true", () => {
    const comment = buildOwnershipComment(
      { teamFiles: new Map(), unownedFiles: [], defaultedFiles: new Map() },
      true
    );
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
    const comment = buildOwnershipComment(
      { teamFiles: new Map(), unownedFiles: [], defaultedFiles: new Map() },
      false
    );
    expect(comment).not.toContain("Labels will be removed automatically");
    expect(comment).toContain("Review requested from the teams above.");
  });
});

describe("paginated comment lookups", () => {
  it("updates the ownership comment when it's past the first page", async () => {
    const octokit = commentsOctokit(chatter, [{ id: 42, body: `${COMMENT_MARKER}\nold` }]);
    await upsertComment(octokit as any, "owner", "repo", 1, "new");
    expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.issues.listComments, {
      owner: "owner",
      repo: "repo",
      issue_number: 1,
      per_page: 100,
    });
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 42 })
    );
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("skips the external contributor comment when it's past the first page", async () => {
    const octokit = commentsOctokit(chatter, [{ id: 7, body: `${EXTERNAL_COMMENT_MARKER}\nhi` }]);
    await postExternalComment(octokit as any, "owner", "repo", 1, "hi");
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });
});

describe("upsertComment", () => {
  const mockOctokit = {
    rest: {
      issues: { listComments: jest.fn(), createComment: jest.fn(), updateComment: jest.fn() },
    },
    // One page: the listComments mock's data.
    paginate: jest.fn(
      async (method: (p: object) => Promise<{ data: unknown[] }>, params: object) =>
        (await method(params)).data
    ),
  };
  beforeEach(() => jest.clearAllMocks());

  it("creates a new comment when none exists", async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    mockOctokit.rest.issues.createComment.mockResolvedValue({});
    await upsertComment(mockOctokit as any, "owner", "repo", 1, "body");
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      issue_number: 1,
      body: "body",
    });
  });

  it("updates existing comment when marker is found", async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({
      data: [{ id: 42, body: `${COMMENT_MARKER}\nold content` }],
    });
    mockOctokit.rest.issues.updateComment.mockResolvedValue({});
    await upsertComment(mockOctokit as any, "owner", "repo", 1, `${COMMENT_MARKER}\nnew`);
    expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      comment_id: 42,
      body: `${COMMENT_MARKER}\nnew`,
    });
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("uses pre-fetched comment when provided", async () => {
    mockOctokit.rest.issues.updateComment.mockResolvedValue({});
    await upsertComment(mockOctokit as any, "owner", "repo", 1, "new body", {
      id: 99,
      body: "old body",
    });
    expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      comment_id: 99,
      body: "new body",
    });
    expect(mockOctokit.rest.issues.listComments).not.toHaveBeenCalled();
  });

  it("creates comment when pre-fetched is explicitly null", async () => {
    mockOctokit.rest.issues.createComment.mockResolvedValue({});
    await upsertComment(mockOctokit as any, "owner", "repo", 1, "body", null);
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
    expect(mockOctokit.rest.issues.listComments).not.toHaveBeenCalled();
  });
});

describe("embedSlackRefs", () => {
  it("appends slack ref tags to body", () => {
    const body = "## Code Ownership\ncontent";
    const result = embedSlackRefs(body, [{ channel: "C123", ts: "1234.5678" }]);
    expect(result).toContain("<!-- rr:slack:C123:1234.5678 -->");
    expect(result).toContain("## Code Ownership");
  });

  it("appends multiple refs", () => {
    const result = embedSlackRefs("body", [
      { channel: "C123", ts: "1234.5678" },
      { channel: "C456", ts: "9012.3456" },
    ]);
    expect(result).toContain("<!-- rr:slack:C123:1234.5678 -->");
    expect(result).toContain("<!-- rr:slack:C456:9012.3456 -->");
  });

  it("returns body unchanged when no refs", () => {
    expect(embedSlackRefs("body", [])).toBe("body");
  });
});

describe("extractSlackRefs", () => {
  it("extracts slack refs from comment body", () => {
    const body = "content\n<!-- rr:slack:C123:1234.5678 -->\n<!-- rr:slack:C456:9012.3456 -->";
    const refs = extractSlackRefs(body);
    expect(refs).toEqual([
      { channel: "C123", ts: "1234.5678" },
      { channel: "C456", ts: "9012.3456" },
    ]);
  });

  it("returns empty array when no refs", () => {
    expect(extractSlackRefs("no refs here")).toEqual([]);
  });
});

describe("embedSlackRefsInDescription", () => {
  it("appends refs block to empty description", () => {
    const result = embedSlackRefsInDescription("", [{ channel: "C123", ts: "1.2" }]);
    expect(result).toBe(
      "\n<!-- rr:slack:start -->\n<!-- rr:slack:C123:1.2 -->\n<!-- rr:slack:end -->"
    );
  });

  it("appends refs block to description without Cursor summary", () => {
    const result = embedSlackRefsInDescription("Some PR description", [
      { channel: "C123", ts: "1.2" },
    ]);
    expect(result).toBe(
      "Some PR description\n<!-- rr:slack:start -->\n<!-- rr:slack:C123:1.2 -->\n<!-- rr:slack:end -->"
    );
  });

  it("inserts refs before CURSOR_SUMMARY marker", () => {
    const desc = "My PR\n<!-- CURSOR_SUMMARY -->\nAuto-generated summary";
    const result = embedSlackRefsInDescription(desc, [{ channel: "C123", ts: "1.2" }]);
    expect(result).toBe(
      "My PR\n<!-- rr:slack:start -->\n<!-- rr:slack:C123:1.2 -->\n<!-- rr:slack:end -->\n<!-- CURSOR_SUMMARY -->\nAuto-generated summary"
    );
  });

  it("replaces existing refs block", () => {
    const desc =
      "My PR\n<!-- rr:slack:start -->\n<!-- rr:slack:OLD:0.0 -->\n<!-- rr:slack:end -->\nMore text";
    const result = embedSlackRefsInDescription(desc, [{ channel: "C999", ts: "9.9" }]);
    expect(result).toBe(
      "My PR\n<!-- rr:slack:start -->\n<!-- rr:slack:C999:9.9 -->\n<!-- rr:slack:end -->\nMore text"
    );
  });

  it("handles multiple refs", () => {
    const result = embedSlackRefsInDescription("desc", [
      { channel: "C1", ts: "1.0" },
      { channel: "C2", ts: "2.0" },
    ]);
    expect(result).toContain("<!-- rr:slack:C1:1.0 -->");
    expect(result).toContain("<!-- rr:slack:C2:2.0 -->");
  });

  it("returns description unchanged when no refs", () => {
    expect(embedSlackRefsInDescription("desc", [])).toBe("desc");
  });
});

describe("extractSlackRefsFromDescription", () => {
  it("extracts refs from description with block markers", () => {
    const desc =
      "My PR\n<!-- rr:slack:start -->\n<!-- rr:slack:C123:1.2 -->\n<!-- rr:slack:C456:3.4 -->\n<!-- rr:slack:end -->";
    expect(extractSlackRefsFromDescription(desc)).toEqual([
      { channel: "C123", ts: "1.2" },
      { channel: "C456", ts: "3.4" },
    ]);
  });

  it("returns empty when no refs block", () => {
    expect(extractSlackRefsFromDescription("Just a description")).toEqual([]);
  });

  it("returns empty for null/undefined body", () => {
    expect(extractSlackRefsFromDescription(null as any)).toEqual([]);
    expect(extractSlackRefsFromDescription(undefined as any)).toEqual([]);
  });
});
