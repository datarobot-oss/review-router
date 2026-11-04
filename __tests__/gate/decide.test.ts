import { decideGate, GateFacts, CommitFacts, ReviewFacts } from "../../src/gate/decide";
import { DependencyFacts } from "../../src/gate/dependabot";
import { GatePolicy, parsePolicy } from "../../src/gate/policy";

const HEAD = "head111";

const policy: GatePolicy = parsePolicy(
  [
    "dependabot:",
    "  allowed_paths: ['requirements/**', config/requirements.txt, Dockerfile]",
    "  max_changed_files: 5",
    "  update_types: [patch, minor]",
  ].join("\n")
);

const noFamilies: GatePolicy = {};

const dependency = (over: Partial<DependencyFacts> = {}): DependencyFacts => ({
  name: "pypdf",
  ecosystem: "pip",
  dependencyType: "direct:production",
  updateType: "patch",
  version: "6.0.1",
  previous: "6.0.0",
  compatibility: 90,
  ...over,
});

const metadata = (type: string) =>
  `Bumps pypdf from 6.0.0 to 6.0.1.\n\n---\nupdated-dependencies:\n- dependency-name: pypdf\n  dependency-type: direct:production\n  update-type: version-update:semver-${type}\n...\n\nSigned-off-by: dependabot[bot] <support@github.com>`;

const dependabotCommit = (over: Partial<CommitFacts> = {}): CommitFacts => ({
  authorLogin: "dependabot[bot]",
  committerLogin: "web-flow",
  verified: true,
  message: metadata("patch"),
  ...over,
});

const dependabotFacts = (over: Partial<GateFacts> = {}): GateFacts => ({
  author: "dependabot[bot]",
  authorType: "Bot",
  isFork: false,
  headRef: "dependabot/pip/pypdf-6.0.1",
  headSha: HEAD,
  files: ["config/requirements.txt"],
  changedFileCount: 1,
  pushers: ["dependabot[bot]"],
  commits: [dependabotCommit()],
  dependencies: [dependency()],
  reviews: [],
  ...over,
});

const humanFacts = (over: Partial<GateFacts> = {}): GateFacts => ({
  author: "alice",
  authorType: "User",
  isFork: false,
  headRef: "alice/feature",
  headSha: HEAD,
  files: ["src/app.py"],
  changedFileCount: 1,
  pushers: ["alice"],
  commits: [{ authorLogin: "alice", committerLogin: "alice", verified: true, message: "Add x" }],
  dependencies: [],
  reviews: [],
  ...over,
});

const review = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({
  user: "bob",
  userType: "User",
  state: "APPROVED",
  commitId: HEAD,
  canWrite: true,
  ...over,
});

describe("approval by a person", () => {
  it("passes when a writer who is not the author approved the current head", () => {
    const decision = decideGate(humanFacts({ reviews: [review()] }), policy);
    expect(decision.conclusion).toBe("success");
    expect(decision.reason).toBe("approved");
  });

  it("waits for a person when nobody approved", () => {
    const decision = decideGate(humanFacts(), policy);
    expect(decision.conclusion).toBe("action_required");
    expect(decision.reason).toBe("needs-approval");
  });

  it("ignores an approval of an older commit", () => {
    const decision = decideGate(humanFacts({ reviews: [review({ commitId: "old000" })] }), policy);
    expect(decision.conclusion).toBe("action_required");
  });

  it("ignores an approval from a reviewer without write access", () => {
    const decision = decideGate(humanFacts({ reviews: [review({ canWrite: false })] }), policy);
    expect(decision.conclusion).toBe("action_required");
  });

  it("ignores an approval from an App or bot account", () => {
    const decision = decideGate(humanFacts({ reviews: [review({ userType: "Bot" })] }), policy);
    expect(decision.conclusion).toBe("action_required");
  });

  it("ignores the author's own approval", () => {
    const decision = decideGate(humanFacts({ reviews: [review({ user: "alice" })] }), policy);
    expect(decision.conclusion).toBe("action_required");
  });

  it("ignores the author's own approval when others made all the commits", () => {
    const facts = humanFacts({
      commits: [{ authorLogin: "carol", committerLogin: "carol", verified: true, message: "x" }],
      reviews: [review({ user: "alice" })],
    });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("ignores an approval from someone who pushed to the branch, whatever the commit emails say", () => {
    const facts = humanFacts({
      commits: [{ authorLogin: null, committerLogin: null, verified: false, message: "x" }],
      pushers: ["alice", "bob"],
      reviews: [review({ user: "bob" })],
    });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("ignores an approval from someone who authored a commit in the pull request", () => {
    const facts = humanFacts({
      commits: [
        { authorLogin: "alice", committerLogin: "alice", verified: true, message: "Add x" },
        { authorLogin: "bob", committerLogin: "bob", verified: true, message: "Fix x" },
      ],
      reviews: [review({ user: "bob" })],
    });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("ignores an approval from someone who committed a commit in the pull request", () => {
    const facts = humanFacts({
      commits: [{ authorLogin: "alice", committerLogin: "bob", verified: true, message: "Add x" }],
      reviews: [review({ user: "bob" })],
    });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("passes with a second approver when the first one is disqualified", () => {
    const facts = humanFacts({
      reviews: [review({ user: "alice" }), review({ user: "carol" })],
    });
    expect(decideGate(facts, policy).conclusion).toBe("success");
  });

  it("blocks when a writer's latest review requests changes, even beside an approval", () => {
    const facts = humanFacts({
      reviews: [
        review(),
        review({ user: "carol", state: "CHANGES_REQUESTED", commitId: "old000" }),
      ],
    });
    const decision = decideGate(facts, policy);
    expect(decision.conclusion).toBe("action_required");
    expect(decision.reason).toBe("changes-requested");
  });

  it("does not block on a change request from a reviewer without write access", () => {
    const facts = humanFacts({
      reviews: [review(), review({ user: "mallory", state: "CHANGES_REQUESTED", canWrite: false })],
    });
    expect(decideGate(facts, policy).conclusion).toBe("success");
  });

  it("does not block on a change request from a bot with write access", () => {
    const facts = humanFacts({
      reviews: [
        review(),
        review({ user: "some-app[bot]", userType: "Bot", state: "CHANGES_REQUESTED" }),
      ],
    });
    expect(decideGate(facts, policy).conclusion).toBe("success");
  });

  it("lets a person approve a pull request that changes workflow files", () => {
    const facts = humanFacts({ files: [".github/workflows/ci.yml"], reviews: [review()] });
    expect(decideGate(facts, policy).conclusion).toBe("success");
  });
});

describe("Dependabot family", () => {
  it("passes a genuine Dependabot patch bump inside the allowed paths without a review", () => {
    const decision = decideGate(dependabotFacts(), policy);
    expect(decision.conclusion).toBe("success");
    expect(decision.reason).toBe("dependabot");
  });

  it("passes a minor bump", () => {
    const facts = dependabotFacts({ dependencies: [dependency({ updateType: "minor" })] });
    expect(decideGate(facts, policy).conclusion).toBe("success");
  });

  it("names the dependencies it passed", () => {
    const facts = dependabotFacts({
      dependencies: [dependency(), dependency({ name: "other", updateType: "minor" })],
    });
    const decision = decideGate(facts, policy);
    expect(decision.conclusion).toBe("success");
    expect(decision.summary).toContain("pypdf");
    expect(decision.summary).toContain("other");
  });

  it("needs a person for a major bump, and says which dependency", () => {
    const facts = dependabotFacts({ dependencies: [dependency({ updateType: "major" })] });
    const decision = decideGate(facts, policy);
    expect(decision.conclusion).toBe("action_required");
    expect(decision.summary).toContain("pypdf");
    expect(decision.summary).toContain("major");
  });

  it("needs a person when one dependency of a group is a major bump", () => {
    const facts = dependabotFacts({
      dependencies: [dependency(), dependency({ name: "other", updateType: "major" })],
    });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("needs a person when the commit lists no dependency", () => {
    expect(decideGate(dependabotFacts({ dependencies: [] }), policy).conclusion).toBe(
      "action_required"
    );
  });

  it("needs a person for a compatibility score below the minimum", () => {
    const facts = dependabotFacts({ dependencies: [dependency({ compatibility: 50 })] });
    const decision = decideGate(facts, policy);
    expect(decision.conclusion).toBe("action_required");
    expect(decision.summary).toContain("50%");
  });

  it("needs a person when the repository enables no family", () => {
    expect(decideGate(dependabotFacts(), noFamilies).conclusion).toBe("action_required");
  });

  it("needs a person for a file outside the allowed paths", () => {
    const facts = dependabotFacts({ files: ["config/requirements.txt", "src/app.py"] });
    const decision = decideGate(facts, policy);
    expect(decision.conclusion).toBe("action_required");
    expect(decision.summary).toContain("src/app.py");
  });

  it("needs a person for any workflow file, even when the paths allow it", () => {
    const wide: GatePolicy = {
      dependabot: { ...policy.dependabot!, allowedPaths: ["**"] },
    };
    const facts = dependabotFacts({ files: [".github/workflows/ci.yml"] });
    expect(decideGate(facts, wide).conclusion).toBe("action_required");
  });

  it("needs a person when a rename leaves a protected path", () => {
    // The facts list a renamed file under both its new and its previous name.
    const facts = dependabotFacts({
      files: ["config/requirements.txt", ".github/workflows/ci.yml"],
    });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("needs a person when the change is larger than the file limit", () => {
    const files = Array.from({ length: 6 }, (_, i) => `requirements/r${i}.txt`);
    const facts = dependabotFacts({ files, changedFileCount: 6 });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("passes a change of exactly the file limit", () => {
    const files = Array.from({ length: 5 }, (_, i) => `requirements/r${i}.txt`);
    const facts = dependabotFacts({ files, changedFileCount: 5 });
    expect(decideGate(facts, policy).conclusion).toBe("success");
  });

  it("counts a renamed file once toward the file limit", () => {
    const files = [
      ...Array.from({ length: 4 }, (_, i) => `requirements/r${i}.txt`),
      "requirements/new.txt",
      "requirements/old.txt",
    ];
    const facts = dependabotFacts({ files, changedFileCount: 5 });
    expect(decideGate(facts, policy).conclusion).toBe("success");
  });

  it("needs a person for a pull request that changes no file", () => {
    expect(decideGate(dependabotFacts({ files: [] }), policy).conclusion).toBe("action_required");
  });

  it("needs a person when a human pushed a commit onto the Dependabot branch", () => {
    const facts = dependabotFacts({
      commits: [
        dependabotCommit(),
        {
          authorLogin: "mallory",
          committerLogin: "mallory",
          verified: true,
          message: metadata("patch"),
        },
      ],
    });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("needs a person when an account other than Dependabot pushed to the branch", () => {
    const facts = dependabotFacts({ pushers: ["dependabot[bot]", "some-app[bot]"] });
    const decision = decideGate(facts, policy);
    expect(decision.conclusion).toBe("action_required");
    expect(decision.summary).toContain("pushed");
  });

  it("needs a person when the CI rebuild bot pushed to the branch", () => {
    const facts = dependabotFacts({ pushers: ["dependabot[bot]", "github-actions[bot]"] });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("needs a person when no push to the branch is on record", () => {
    expect(decideGate(dependabotFacts({ pushers: [] }), policy).conclusion).toBe("action_required");
  });

  it("needs a person when a commit claims Dependabot as author but another account committed it", () => {
    const facts = dependabotFacts({ commits: [dependabotCommit({ committerLogin: "mallory" })] });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("needs a person when the commit signature is not verified", () => {
    const facts = dependabotFacts({ commits: [dependabotCommit({ verified: false })] });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("needs a person when another bot opened the pull request", () => {
    const facts = dependabotFacts({ author: "renovate[bot]" });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("needs a person when the commit author is not Dependabot", () => {
    const facts = dependabotFacts({ commits: [dependabotCommit({ authorLogin: "mallory" })] });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("needs a person when the pull request has no commits", () => {
    expect(decideGate(dependabotFacts({ commits: [] }), policy).conclusion).toBe("action_required");
  });

  it("needs a person when the author is a user named like Dependabot", () => {
    const facts = dependabotFacts({ authorType: "User" });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });

  it("needs a person when the branch does not start with dependabot/", () => {
    expect(decideGate(dependabotFacts({ headRef: "feature/x" }), policy).conclusion).toBe(
      "action_required"
    );
  });

  it("needs a person for a fork branch named like Dependabot's", () => {
    expect(decideGate(dependabotFacts({ isFork: true }), policy).conclusion).toBe(
      "action_required"
    );
  });

  it("still blocks on a writer's change request", () => {
    const facts = dependabotFacts({
      reviews: [review({ state: "CHANGES_REQUESTED", commitId: "old000" })],
    });
    const decision = decideGate(facts, policy);
    expect(decision.conclusion).toBe("action_required");
    expect(decision.reason).toBe("changes-requested");
  });

  it("matches a path pattern against the whole path, not a prefix", () => {
    const facts = dependabotFacts({ files: ["requirements/../src/app.py"] });
    expect(decideGate(facts, policy).conclusion).toBe("action_required");
  });
});

describe("explanations", () => {
  it("tells a person what is needed and why the family did not apply", () => {
    const decision = decideGate(dependabotFacts({ files: ["src/app.py"] }), policy);
    expect(decision.title).toBe("Waiting for an approval");
    expect(decision.summary).toContain("write access");
    expect(decision.summary).toContain("src/app.py");
  });

  it("names the approver on a pass", () => {
    const decision = decideGate(humanFacts({ reviews: [review()] }), policy);
    expect(decision.summary).toContain("@bob");
  });
});
