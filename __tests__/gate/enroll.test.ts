import { loadEnrollment } from "../../src/gate/enroll";
import { Octokit } from "../../src/types";

jest.mock("@actions/core");

const file = (text: string) => ({
  data: { type: "file", content: Buffer.from(text).toString("base64") },
});
const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

function fakeOctokit(opts: { policy?: string | Error; rules?: object[] | Error }) {
  const getContent = jest.fn(async () => {
    if (opts.policy instanceof Error) throw opts.policy;
    if (opts.policy === undefined) throw notFound();
    return file(opts.policy);
  });
  const getBranchRules = Symbol("getBranchRules");
  const octokit = {
    rest: { repos: { getContent, getBranchRules } },
    paginate: jest.fn(async () => {
      if (opts.rules instanceof Error) throw opts.rules;
      return opts.rules ?? [];
    }),
  };
  return { octokit: octokit as unknown as Octokit, getContent, paginate: octokit.paginate };
}

const gateRule = {
  type: "required_status_checks",
  parameters: { required_status_checks: [{ context: "Review Router gate" }] },
};

describe("loadEnrollment", () => {
  it("reads the policy file from the default branch", async () => {
    const { octokit, getContent } = fakeOctokit({
      policy: "dependabot:\n  allowed_paths: [a]",
    });
    const enrollment = await loadEnrollment(octokit, "o", "r", "main");
    expect(enrollment?.policy.dependabot?.allowedPaths).toEqual(["a"]);
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: ".github/review-router.yml", ref: "main" })
    );
  });

  it("enrolls a repository whose policy file holds only comments, with no family", async () => {
    const { octokit } = fakeOctokit({ policy: "# nothing yet\n" });
    expect(await loadEnrollment(octokit, "o", "r", "main")).toEqual({ policy: {} });
  });

  it("enrolls a repository that requires the gate check, without a policy file", async () => {
    const { octokit } = fakeOctokit({ rules: [gateRule] });
    expect(await loadEnrollment(octokit, "o", "r", "main")).toEqual({ policy: {} });
  });

  it("does not enroll a repository with neither a policy file nor the required check", async () => {
    const other = {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "go-no-go" }] },
    };
    const { octokit } = fakeOctokit({ rules: [other, { type: "merge_queue" }] });
    expect(await loadEnrollment(octokit, "o", "r", "main")).toBeNull();
  });

  it("fails when the branch rules can't be read, instead of reading it as not enrolled", async () => {
    const { octokit } = fakeOctokit({ rules: new Error("boom") });
    await expect(loadEnrollment(octokit, "o", "r", "main")).rejects.toThrow("boom");
  });

  it("keeps the repository enrolled with no family when the policy file is invalid", async () => {
    const { octokit } = fakeOctokit({ policy: "dependabot: [unclosed" });
    const enrollment = await loadEnrollment(octokit, "o", "r", "main");
    expect(enrollment?.policy).toEqual({});
    expect(enrollment?.policyError).toBeTruthy();
  });

  it("fails when the policy file can't be read for a reason other than being absent", async () => {
    const { octokit } = fakeOctokit({
      policy: Object.assign(new Error("server"), { status: 500 }),
    });
    await expect(loadEnrollment(octokit, "o", "r", "main")).rejects.toThrow("server");
  });

  it("fails when the policy path is a directory", async () => {
    const { octokit, getContent } = fakeOctokit({});
    getContent.mockResolvedValue({ data: [{ type: "file" }] } as never);
    await expect(loadEnrollment(octokit, "o", "r", "main")).rejects.toThrow(/not a file/);
  });
});
