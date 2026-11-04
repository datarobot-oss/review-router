import { collectFacts, standingReviews } from "../../src/gate/facts";
import { Octokit } from "../../src/types";

const user = (login: string, type = "User") => ({ login, type });
const review = (login: string, state: string, commitId = "h1") => ({
  state,
  commit_id: commitId,
  user: user(login),
});

describe("standingReviews", () => {
  it("keeps the latest approval or change request of each person", () => {
    const standing = standingReviews([
      review("bob", "CHANGES_REQUESTED", "h1"),
      review("bob", "APPROVED", "h2"),
    ]);
    expect(standing.get("bob")?.state).toBe("APPROVED");
    expect(standing.get("bob")?.commit_id).toBe("h2");
  });

  it("lets a later change request replace an approval", () => {
    const standing = standingReviews([
      review("bob", "APPROVED"),
      review("bob", "CHANGES_REQUESTED"),
    ]);
    expect(standing.get("bob")?.state).toBe("CHANGES_REQUESTED");
  });

  it("drops a dismissed review", () => {
    expect(standingReviews([review("bob", "DISMISSED")]).size).toBe(0);
    expect(standingReviews([review("bob", "APPROVED"), review("bob", "DISMISSED")]).size).toBe(0);
  });

  it("does not let a plain comment cancel an approval", () => {
    const standing = standingReviews([review("bob", "APPROVED"), review("bob", "COMMENTED")]);
    expect(standing.get("bob")?.state).toBe("APPROVED");
  });

  it("ignores pending reviews and reviews from deleted accounts", () => {
    const standing = standingReviews([
      review("bob", "PENDING"),
      { state: "APPROVED", commit_id: "h1", user: null },
    ]);
    expect(standing.size).toBe(0);
  });
});

interface Overrides {
  pr?: Record<string, unknown>;
  files?: object[];
  commits?: object[];
  reviews?: object[];
  permission?: (username: string) => Promise<{ data: { permission: string } }>;
}

function fakeOctokit(over: Overrides = {}) {
  const pr = {
    state: "open",
    commits: 1,
    changed_files: 1,
    user: user("dependabot[bot]", "Bot"),
    base: { ref: "main", repo: { full_name: "o/r" } },
    head: { ref: "dependabot/pip/x", sha: "h1", repo: { full_name: "o/r" } },
    ...over.pr,
  };
  const listFiles = Symbol("listFiles");
  const listCommits = Symbol("listCommits");
  const listReviews = Symbol("listReviews");
  const lists = new Map<symbol, object[]>([
    [listFiles, over.files ?? [{ filename: "requirements.txt" }]],
    [
      listCommits,
      over.commits ?? [
        {
          author: { login: "dependabot[bot]" },
          committer: { login: "web-flow" },
          commit: { message: "Bump", verification: { verified: true } },
        },
      ],
    ],
    [listReviews, over.reviews ?? []],
  ]);
  const permission = jest.fn(over.permission ?? (async () => ({ data: { permission: "write" } })));
  const octokit = {
    rest: {
      pulls: {
        get: jest.fn().mockResolvedValue({ data: pr }),
        listFiles,
        listCommits,
        listReviews,
      },
      repos: { getCollaboratorPermissionLevel: permission },
    },
    paginate: jest.fn(async (method: symbol) => lists.get(method) ?? []),
  };
  return { octokit: octokit as unknown as Octokit, permission };
}

describe("collectFacts", () => {
  it("reads the author, branch, commits and files of the pull request", async () => {
    const { octokit } = fakeOctokit();
    const { facts, baseRef, state } = await collectFacts(octokit, "o", "r", 7);
    expect(facts).toMatchObject({
      author: "dependabot[bot]",
      authorType: "Bot",
      isFork: false,
      headRef: "dependabot/pip/x",
      headSha: "h1",
      files: ["requirements.txt"],
    });
    expect(facts.commits).toEqual([
      {
        authorLogin: "dependabot[bot]",
        committerLogin: "web-flow",
        verified: true,
        message: "Bump",
      },
    ]);
    expect(baseRef).toBe("main");
    expect(state).toBe("open");
  });

  it("lists a renamed file under both names", async () => {
    const { octokit } = fakeOctokit({
      files: [{ filename: "new.txt", previous_filename: ".github/workflows/old.yml" }],
    });
    const { facts } = await collectFacts(octokit, "o", "r", 7);
    expect(facts.files).toEqual(["new.txt", ".github/workflows/old.yml"]);
  });

  it("marks a pull request from another repository as a fork, also when the fork is deleted", async () => {
    const other = fakeOctokit({
      pr: { head: { ref: "dependabot/x", sha: "h1", repo: { full_name: "evil/r" } } },
    });
    expect((await collectFacts(other.octokit, "o", "r", 7)).facts.isFork).toBe(true);
    const deleted = fakeOctokit({ pr: { head: { ref: "dependabot/x", sha: "h1", repo: null } } });
    expect((await collectFacts(deleted.octokit, "o", "r", 7)).facts.isFork).toBe(true);
  });

  it("treats a commit without a verification result as unverified", async () => {
    const { octokit } = fakeOctokit({
      commits: [{ author: null, committer: null, commit: { message: "x" } }],
    });
    const { facts } = await collectFacts(octokit, "o", "r", 7);
    expect(facts.commits[0]).toEqual({
      authorLogin: null,
      committerLogin: null,
      verified: false,
      message: "x",
    });
  });

  it("resolves write access once per reviewer", async () => {
    const { octokit, permission } = fakeOctokit({
      reviews: [review("bob", "APPROVED"), review("bob", "CHANGES_REQUESTED")],
    });
    const { facts } = await collectFacts(octokit, "o", "r", 7);
    expect(facts.reviews).toEqual([
      { user: "bob", userType: "User", state: "CHANGES_REQUESTED", commitId: "h1", canWrite: true },
    ]);
    expect(permission).toHaveBeenCalledTimes(1);
  });

  it("reads read-only and triage permissions as no write access", async () => {
    const { octokit } = fakeOctokit({
      reviews: [review("bob", "APPROVED")],
      permission: async () => ({ data: { permission: "read" } }),
    });
    expect((await collectFacts(octokit, "o", "r", 7)).facts.reviews[0].canWrite).toBe(false);
  });

  it("fails when the permission lookup fails, instead of reading it as no access", async () => {
    const { octokit } = fakeOctokit({
      reviews: [review("bob", "CHANGES_REQUESTED")],
      permission: async () => {
        throw new Error("rate limited");
      },
    });
    await expect(collectFacts(octokit, "o", "r", 7)).rejects.toThrow("rate limited");
  });

  it("fails when the pull request has more commits than the API lists", async () => {
    const { octokit } = fakeOctokit({ pr: { commits: 251 } });
    await expect(collectFacts(octokit, "o", "r", 7)).rejects.toThrow(/250 commits/);
  });

  it("fails when the pull request changes more files than the API lists", async () => {
    const { octokit } = fakeOctokit({ pr: { changed_files: 3001 } });
    await expect(collectFacts(octokit, "o", "r", 7)).rejects.toThrow(/3000 files/);
  });

  it("fails when a list comes back shorter than the pull request reports", async () => {
    const { octokit } = fakeOctokit({ pr: { changed_files: 2 } });
    await expect(collectFacts(octokit, "o", "r", 7)).rejects.toThrow(/fewer/);
  });
});
