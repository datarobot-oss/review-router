import * as core from "@actions/core";
import {
  EXTERNAL_COMMENT_MARKER,
  JIRA_COMMENT_MARKER,
  WELCOME_DOCS_URL,
  WELCOME_MARKER,
  setWelcomeSection,
  upsertWelcomeSection,
} from "../src/welcome";

jest.mock("@actions/core");

const FOOTER = `<sub>[How Review Router works](${WELCOME_DOCS_URL})</sub>`;

describe("setWelcomeSection", () => {
  it("builds the comment from nothing with the marker, the section and the docs footer", () => {
    const body = setWelcomeSection("", "jira", "🎫 **LAB-1**");
    expect(body.startsWith(WELCOME_MARKER)).toBe(true);
    expect(body).toContain("<!-- rr:section:jira -->\n🎫 **LAB-1**\n<!-- /rr:section:jira -->");
    expect(body.endsWith(FOOTER)).toBe(true);
  });

  it("adds a second section after the first and keeps one footer", () => {
    const first = setWelcomeSection("", "jira", "jira text");
    const both = setWelcomeSection(first, "external", "external text");
    expect(both.indexOf("jira text")).toBeLessThan(both.indexOf("external text"));
    expect(both.split(FOOTER)).toHaveLength(2);
  });

  it("orders the sections the same whichever one was written first", () => {
    const externalFirst = setWelcomeSection(setWelcomeSection("", "external", "E"), "jira", "J");
    const jiraFirst = setWelcomeSection(setWelcomeSection("", "jira", "J"), "external", "E");
    expect(externalFirst).toBe(jiraFirst);
  });

  it("replaces one section and leaves the other as it was", () => {
    const both = setWelcomeSection(setWelcomeSection("", "jira", "old"), "external", "keep me");
    const updated = setWelcomeSection(both, "jira", "new");
    expect(updated).toContain("new");
    expect(updated).not.toContain("old");
    expect(updated).toContain("keep me");
  });

  it("starts over when the body holds no sections", () => {
    const body = setWelcomeSection("some text someone typed", "jira", "J");
    expect(body).not.toContain("some text someone typed");
  });
});

describe("upsertWelcomeSection", () => {
  function fakeOctokit(comments: object[] = []) {
    return {
      rest: {
        issues: {
          listComments: Symbol("listComments"),
          createComment: jest.fn().mockResolvedValue({}),
          updateComment: jest.fn().mockResolvedValue({}),
          deleteComment: jest.fn().mockResolvedValue({}),
        },
      },
      paginate: jest.fn().mockResolvedValue(comments),
    };
  }
  const call = (octokit: object, section: "jira" | "external", content: string) =>
    upsertWelcomeSection(octokit as never, "o", "r", 5, section, content);

  beforeEach(() => jest.clearAllMocks());

  it("creates the welcome comment when the PR has none", async () => {
    const octokit = fakeOctokit();
    await call(octokit, "jira", "J");
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 5,
      body: setWelcomeSection("", "jira", "J"),
    });
  });

  it("updates the welcome comment and keeps the section it did not touch", async () => {
    const existing = setWelcomeSection(setWelcomeSection("", "jira", "old"), "external", "E");
    const octokit = fakeOctokit([{ id: 9, body: existing }]);
    await call(octokit, "jira", "new");
    const { comment_id, body } = octokit.rest.issues.updateComment.mock.calls[0][0];
    expect(comment_id).toBe(9);
    expect(body).toContain("new");
    expect(body).toContain("E");
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("skips the write when the section already reads the same", async () => {
    const existing = setWelcomeSection("", "jira", "J");
    const octokit = fakeOctokit([{ id: 9, body: existing }]);
    await call(octokit, "jira", "J");
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("moves a legacy Jira comment into the welcome comment and deletes the old one", async () => {
    const octokit = fakeOctokit([{ id: 3, body: `${JIRA_COMMENT_MARKER}\n🎫 old card` }]);
    await call(octokit, "jira", "J");
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.deleteComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      comment_id: 3,
    });
  });

  it("keeps a legacy Jira comment when the welcome comment could not be written", async () => {
    const octokit = fakeOctokit([{ id: 3, body: `${JIRA_COMMENT_MARKER}\nold` }]);
    octokit.rest.issues.createComment.mockRejectedValue(new Error("403"));
    await call(octokit, "jira", "J");
    expect(octokit.rest.issues.deleteComment).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalled();
  });

  it("adds the external message once", async () => {
    const octokit = fakeOctokit();
    await call(octokit, "external", "Thanks for contributing");
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("leaves an external message that is already in the welcome comment alone", async () => {
    const existing = setWelcomeSection("", "external", "Thanks, first version");
    const octokit = fakeOctokit([{ id: 9, body: existing }]);
    await call(octokit, "external", "Thanks, edited version");
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("leaves a legacy external comment alone and adds nothing", async () => {
    const octokit = fakeOctokit([{ id: 4, body: `${EXTERNAL_COMMENT_MARKER}\nhi` }]);
    await call(octokit, "external", "hi");
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.deleteComment).not.toHaveBeenCalled();
  });

  it("warns instead of throwing when the API fails", async () => {
    const octokit = fakeOctokit();
    octokit.paginate.mockRejectedValue(new Error("500"));
    await expect(call(octokit, "jira", "J")).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("500"));
  });
});
