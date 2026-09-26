import {
  extractTicketIds,
  resolveCloudId,
  fetchTicket,
  buildJiraComment,
  JIRA_COMMENT_MARKER,
  postJiraComment,
} from "../src/jira";
import * as core from "@actions/core";

jest.mock("@actions/core");

describe("extractTicketIds", () => {
  it("extracts a single bracketed ticket ID", () => {
    expect(extractTicketIds("[PROJ-6000] Add proxy route")).toEqual(["PROJ-6000"]);
  });

  it("extracts multiple bracketed ticket IDs", () => {
    expect(extractTicketIds("[PROJ-100][PROJ-200] Fix two things")).toEqual([
      "PROJ-100",
      "PROJ-200",
    ]);
  });

  it("returns empty array when no ticket ID present", () => {
    expect(extractTicketIds("Fix the login bug")).toEqual([]);
  });

  it("ignores lowercase brackets", () => {
    expect(extractTicketIds("[app-6000] Add proxy route")).toEqual([]);
  });

  it("ignores brackets without a numeric suffix", () => {
    expect(extractTicketIds("[APP] Add proxy route")).toEqual([]);
  });

  it("ignores unbracketed ticket-shaped text", () => {
    expect(extractTicketIds("PROJ-6000 Add proxy route")).toEqual([]);
  });

  it("dedupes a ticket ID repeated in the title", () => {
    expect(extractTicketIds("[PROJ-1] backport of [PROJ-1]")).toEqual(["PROJ-1"]);
  });
});

describe("resolveCloudId", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("returns the cloud ID from tenant_info", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cloudId: "abc-123" }),
    });
    const cloudId = await resolveCloudId("https://acme.atlassian.net");
    expect(cloudId).toBe("abc-123");
    expect(fetchMock).toHaveBeenCalledWith("https://acme.atlassian.net/_edge/tenant_info", {
      headers: { Accept: "application/json" },
    });
  });

  it("strips a trailing slash from base_url", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cloudId: "abc-123" }),
    });
    await resolveCloudId("https://acme.atlassian.net/");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://acme.atlassian.net/_edge/tenant_info",
      expect.anything()
    );
  });

  it("returns null and warns on a non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const cloudId = await resolveCloudId("https://acme.atlassian.net");
    expect(cloudId).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("500"));
  });

  it("returns null and warns on network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const cloudId = await resolveCloudId("https://acme.atlassian.net");
    expect(cloudId).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("returns null when cloudId is absent", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const cloudId = await resolveCloudId("https://acme.atlassian.net");
    expect(cloudId).toBeNull();
  });
});

describe("fetchTicket", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("fetches through the gateway with a Bearer token and returns summary, type, and parent", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        fields: {
          summary: "Fix the login redirect bug",
          issuetype: { name: "Bug" },
          parent: { key: "PROJ-6000", fields: { summary: "Auth cleanup" } },
        },
      }),
    });
    const ticket = await fetchTicket("PROJ-6235", "abc-123", "tok");
    expect(ticket).toEqual({
      summary: "Fix the login redirect bug",
      type: "Bug",
      parent: { id: "PROJ-6000", summary: "Auth cleanup" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.atlassian.com/ex/jira/abc-123/rest/api/3/issue/PROJ-6235?fields=summary,issuetype,parent",
      {
        headers: {
          Authorization: "Bearer tok",
          Accept: "application/json",
        },
      }
    );
  });

  it("leaves out type and parent when the ticket has none", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ fields: { summary: "First" } }),
    });
    expect(await fetchTicket("PROJ-1", "abc-123", "tok")).toEqual({ summary: "First" });
  });

  it("returns null and warns on 401", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const ticket = await fetchTicket("PROJ-6235", "abc-123", "tok");
    expect(ticket).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("401"));
  });

  it("returns null and warns on 404", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const ticket = await fetchTicket("PROJ-9999", "abc-123", "tok");
    expect(ticket).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("404"));
  });

  it("returns null and warns on network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const ticket = await fetchTicket("PROJ-6235", "abc-123", "tok");
    expect(ticket).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("returns null when summary field is absent", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ fields: {} }) });
    expect(await fetchTicket("PROJ-1", "abc-123", "tok")).toBeNull();
  });
});

describe("buildJiraComment", () => {
  it("renders a ticket as a card: link and type, quoted summary, and parent", () => {
    const body = buildJiraComment("https://acme.atlassian.net", [
      {
        id: "PROJ-6235",
        summary: "Fix the login redirect bug",
        type: "Bug",
        parent: { id: "PROJ-6000", summary: "Auth cleanup" },
      },
    ]);
    expect(body).toBe(
      [
        JIRA_COMMENT_MARKER,
        "🎫 **[PROJ-6235](https://acme.atlassian.net/browse/PROJ-6235)** · Bug",
        "> Fix the login redirect bug",
        "",
        "<sub>Part of [PROJ-6000](https://acme.atlassian.net/browse/PROJ-6000) · Auth cleanup</sub>",
      ].join("\n")
    );
  });

  it("leaves out the type and the parent line when the ticket has neither", () => {
    const body = buildJiraComment("https://acme.atlassian.net", [
      { id: "PROJ-1", summary: "First" },
    ]);
    expect(body).toBe(
      [
        JIRA_COMMENT_MARKER,
        "🎫 **[PROJ-1](https://acme.atlassian.net/browse/PROJ-1)**",
        "> First",
      ].join("\n")
    );
  });

  it("renders a ticket without a title as a link and adds the footer note", () => {
    const body = buildJiraComment("https://acme.atlassian.net", [
      { id: "PROJ-6235", summary: null },
    ]);
    expect(body).toContain("🎫 **[PROJ-6235](https://acme.atlassian.net/browse/PROJ-6235)**");
    expect(body).not.toContain("\n> ");
    expect(body).toContain("Add a `jira-token` input for ticket titles here.");
  });

  it("renders one card per ticket, separated by a blank line", () => {
    const body = buildJiraComment("https://acme.atlassian.net", [
      { id: "PROJ-100", summary: "First", type: "Story" },
      { id: "PROJ-200", summary: "Second", type: "Task" },
    ]);
    expect(body).toContain(
      "> First\n\n🎫 **[PROJ-200](https://acme.atlassian.net/browse/PROJ-200)** · Task\n> Second"
    );
  });

  it("adds the footer note only once when multiple tickets are missing titles", () => {
    const body = buildJiraComment("https://acme.atlassian.net", [
      { id: "PROJ-100", summary: null },
      { id: "PROJ-200", summary: null },
    ]);
    expect(body.match(/Add a `jira-token` input/g)).toHaveLength(1);
  });

  it("strips a trailing slash from base_url in links", () => {
    const body = buildJiraComment("https://acme.atlassian.net/", [{ id: "PROJ-1", summary: null }]);
    expect(body).toContain("(https://acme.atlassian.net/browse/PROJ-1)");
  });
});

describe("postJiraComment", () => {
  const mockOctokit = {
    rest: {
      issues: {
        listComments: jest.fn(),
        createComment: jest.fn(),
        updateComment: jest.fn(),
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does nothing when jira config is undefined", async () => {
    await postJiraComment(mockOctokit as any, "o", "r", 1, "[PROJ-1] x", undefined, "");
    expect(mockOctokit.rest.issues.listComments).not.toHaveBeenCalled();
  });

  it("does nothing when jira.enabled is false", async () => {
    await postJiraComment(
      mockOctokit as any,
      "o",
      "r",
      1,
      "[PROJ-1] x",
      { enabled: false, base_url: "https://acme.atlassian.net" },
      ""
    );
    expect(mockOctokit.rest.issues.listComments).not.toHaveBeenCalled();
  });

  it("warns and does nothing when enabled but base_url is missing", async () => {
    await postJiraComment(mockOctokit as any, "o", "r", 1, "[PROJ-1] x", { enabled: true }, "");
    expect(mockOctokit.rest.issues.listComments).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("base_url"));
  });

  it("does nothing when no ticket ID is in the title", async () => {
    await postJiraComment(
      mockOctokit as any,
      "o",
      "r",
      1,
      "Fix the login bug",
      { enabled: true, base_url: "https://acme.atlassian.net" },
      ""
    );
    expect(mockOctokit.rest.issues.listComments).not.toHaveBeenCalled();
  });

  it("creates a comment with ID-only link when no token is set", async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    await postJiraComment(
      mockOctokit as any,
      "o",
      "r",
      1,
      "[PROJ-6235] Migrate logs",
      { enabled: true, base_url: "https://acme.atlassian.net" },
      ""
    );
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 1,
      body: expect.stringContaining("**[PROJ-6235](https://acme.atlassian.net/browse/PROJ-6235)**"),
    });
  });

  it("fetches the ticket and creates a card when a token is set", async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ cloudId: "abc-123" }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          fields: { summary: "Fix the login redirect bug", issuetype: { name: "Bug" } },
        }),
      }) as unknown as typeof fetch;

    await postJiraComment(
      mockOctokit as any,
      "o",
      "r",
      1,
      "[PROJ-6235] Migrate logs",
      { enabled: true, base_url: "https://acme.atlassian.net" },
      "tok"
    );
    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 1,
      body: expect.stringContaining(
        "🎫 **[PROJ-6235](https://acme.atlassian.net/browse/PROJ-6235)** · Bug\n> Fix the login redirect bug"
      ),
    });
  });

  it("posts an ID-only link with the footer when a token is set but cloud ID resolution fails", async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    global.fetch = fetchMock as unknown as typeof fetch;

    await postJiraComment(
      mockOctokit as any,
      "o",
      "r",
      1,
      "[PROJ-6235] Migrate logs",
      { enabled: true, base_url: "https://acme.atlassian.net" },
      "tok"
    );

    // Only tenant_info is called; no per-ticket summary fetch after resolution fails.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = mockOctokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain("**[PROJ-6235](https://acme.atlassian.net/browse/PROJ-6235)**");
    expect(body).not.toContain("Migrate logs");
    expect(body).toContain("Add a `jira-token` input for ticket titles here.");
  });

  it("updates the existing Jira comment instead of creating a new one", async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({
      data: [{ id: 55, body: `<!-- review-router-jira -->\nold` }],
    });
    await postJiraComment(
      mockOctokit as any,
      "o",
      "r",
      1,
      "[PROJ-6235] Migrate logs",
      { enabled: true, base_url: "https://acme.atlassian.net" },
      ""
    );
    expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", comment_id: 55 })
    );
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("warns and does not throw when the GitHub API call fails", async () => {
    mockOctokit.rest.issues.listComments.mockRejectedValue(new Error("rate limited"));
    await expect(
      postJiraComment(
        mockOctokit as any,
        "o",
        "r",
        1,
        "[PROJ-6235] Migrate logs",
        { enabled: true, base_url: "https://acme.atlassian.net" },
        ""
      )
    ).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
  });
});
