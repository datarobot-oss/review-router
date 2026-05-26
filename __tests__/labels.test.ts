import { ensureLabel, applyLabel, removeLabel } from "../src/labels";

const mockOctokit = {
  rest: {
    issues: {
      createLabel: jest.fn(),
      addLabels: jest.fn(),
      removeLabel: jest.fn(),
    },
  },
};

beforeEach(() => { jest.clearAllMocks(); });

describe("ensureLabel", () => {
  it("creates a label when it does not exist", async () => {
    mockOctokit.rest.issues.createLabel.mockResolvedValue({});
    await ensureLabel(mockOctokit as any, "owner", "repo", "Needs Review: Team", "fbca04");
    expect(mockOctokit.rest.issues.createLabel).toHaveBeenCalledWith({
      owner: "owner", repo: "repo", name: "Needs Review: Team", color: "fbca04",
    });
  });

  it("handles 422 (already exists) gracefully", async () => {
    mockOctokit.rest.issues.createLabel.mockRejectedValue({ status: 422 });
    await expect(ensureLabel(mockOctokit as any, "owner", "repo", "Needs Review: Team", "fbca04")).resolves.not.toThrow();
  });
});

describe("applyLabel", () => {
  it("adds a label to a PR", async () => {
    mockOctokit.rest.issues.addLabels.mockResolvedValue({});
    await applyLabel(mockOctokit as any, "owner", "repo", 1, "Needs Review: Team");
    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: "owner", repo: "repo", issue_number: 1, labels: ["Needs Review: Team"],
    });
  });
});

describe("removeLabel", () => {
  it("removes a label from a PR", async () => {
    mockOctokit.rest.issues.removeLabel.mockResolvedValue({});
    await removeLabel(mockOctokit as any, "owner", "repo", 1, "Needs Review: Team");
    expect(mockOctokit.rest.issues.removeLabel).toHaveBeenCalledWith({
      owner: "owner", repo: "repo", issue_number: 1, name: "Needs Review: Team",
    });
  });

  it("handles 404 (label not on PR) gracefully", async () => {
    mockOctokit.rest.issues.removeLabel.mockRejectedValue({ status: 404 });
    await expect(removeLabel(mockOctokit as any, "owner", "repo", 1, "Needs Review: Team")).resolves.not.toThrow();
  });
});
