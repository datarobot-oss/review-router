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
  activities?: object[] | Error;
}

function fakeOctokit(over: Overrides = {}) {
  const pr = {
    state: "open",
    commits: 1,
    changed_files: 1,
    user: user("dependabot[bot]", "Bot"),
    base: { ref: "main", repo: { full_name: "o/r" } },
    head: {
      ref: "dependabot/pip/x",
      sha: "h1",
      repo: { full_name: "o/r", name: "r", owner: { login: "o" } },
    },
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
  const listActivities = jest.fn(async () => {
    if (over.activities instanceof Error) throw over.activities;
    return {
      data: over.activities ?? [
        { activity_type: "branch_creation", actor: { login: "dependabot[bot]" } },
      ],
    };
  });
  const permission = jest.fn(over.permission ?? (async () => ({ data: { permission: "write" } })));
  const octokit = {
    rest: {
      pulls: {
        get: jest.fn().mockResolvedValue({ data: pr }),
        listFiles,
        listCommits,
        listReviews,
      },
      repos: { getCollaboratorPermissionLevel: permission, listActivities },
    },
    paginate: jest.fn(async (method: symbol) => lists.get(method) ?? []),
  };
  return {
    octokit: octokit as unknown as Octokit,
    permission,
    listActivities,
    paginate: octokit.paginate,
    lists: { listFiles, listCommits, listReviews },
  };
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

  it("marks a pull request from another repository as a fork", async () => {
    const other = fakeOctokit({
      pr: {
        head: {
          ref: "dependabot/x",
          sha: "h1",
          repo: { full_name: "evil/r", name: "r", owner: { login: "evil" } },
        },
      },
    });
    expect((await collectFacts(other.octokit, "o", "r", 7)).facts.isFork).toBe(true);
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

  it("reads a reviewer who is not a collaborator as having no write access", async () => {
    const { octokit } = fakeOctokit({
      reviews: [review("stranger", "CHANGES_REQUESTED")],
      permission: async () => {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
    });
    const { facts } = await collectFacts(octokit, "o", "r", 7);
    expect(facts.reviews[0].canWrite).toBe(false);
  });

  it("reports the number of changed files, counting a rename once", async () => {
    const { octokit } = fakeOctokit({
      pr: { changed_files: 2 },
      files: [{ filename: "a.txt" }, { filename: "new.txt", previous_filename: "old.txt" }],
    });
    const { facts } = await collectFacts(octokit, "o", "r", 7);
    expect(facts.changedFileCount).toBe(2);
    expect(facts.files).toHaveLength(3);
  });

  it("lists everyone who pushed to the head branch, once each", async () => {
    const { octokit, listActivities } = fakeOctokit({
      activities: [
        { activity_type: "push", actor: { login: "alice" } },
        { activity_type: "force_push", actor: { login: "alice" } },
        { activity_type: "branch_creation", actor: { login: "dependabot[bot]" } },
        { activity_type: "branch_deletion", actor: { login: "cleaner" } },
        { activity_type: "pr_merge", actor: { login: "merger" } },
        { activity_type: "merge_queue_merge", actor: { login: "queue-app[bot]" } },
      ],
    });
    const { facts } = await collectFacts(octokit, "o", "r", 7);
    expect(facts.pushers.sort()).toEqual(["alice", "dependabot[bot]", "merger", "queue-app[bot]"]);
    expect(listActivities).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", ref: "refs/heads/dependabot/pip/x" })
    );
  });

  it("reads the pushes of a fork from the fork", async () => {
    const { octokit, listActivities } = fakeOctokit({
      pr: {
        head: {
          ref: "fix",
          sha: "h1",
          repo: { full_name: "evil/r", name: "r", owner: { login: "evil" } },
        },
      },
    });
    await collectFacts(octokit, "o", "r", 7);
    expect(listActivities).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "evil", repo: "r", ref: "refs/heads/fix" })
    );
  });

  it("records a push with no known actor as an unknown pusher", async () => {
    const { octokit } = fakeOctokit({ activities: [{ activity_type: "push", actor: null }] });
    const { facts } = await collectFacts(octokit, "o", "r", 7);
    expect(facts.pushers).toEqual(["(unknown)"]);
  });

  it("fails when the pushes can't be read", async () => {
    const { octokit } = fakeOctokit({ activities: new Error("forbidden") });
    await expect(collectFacts(octokit, "o", "r", 7)).rejects.toThrow(
      "Can't read the push history of o/r: forbidden"
    );
  });

  it("fails when the head repository is gone, so the pushes can't be read", async () => {
    const { octokit } = fakeOctokit({ pr: { head: { ref: "x", sha: "h1", repo: null } } });
    await expect(collectFacts(octokit, "o", "r", 7)).rejects.toThrow(/head repository/);
  });

  it("fails when the push history fills a page, since older pushes may be missing", async () => {
    const page = Array.from({ length: 100 }, () => ({
      activity_type: "push",
      actor: { login: "dependabot[bot]" },
    }));
    const { octokit } = fakeOctokit({ activities: page });
    await expect(collectFacts(octokit, "o", "r", 7)).rejects.toThrow(/pushes/);
  });

  it("reads the reviews after the files, commits and pushes, to keep them as fresh as possible", async () => {
    const { octokit, paginate, lists } = fakeOctokit({ reviews: [review("bob", "APPROVED")] });
    await collectFacts(octokit, "o", "r", 7);
    const order = paginate.mock.calls.map(([method]) => method);
    expect(order.indexOf(lists.listReviews)).toBeGreaterThan(order.indexOf(lists.listFiles));
    expect(order.indexOf(lists.listReviews)).toBeGreaterThan(order.indexOf(lists.listCommits));
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
