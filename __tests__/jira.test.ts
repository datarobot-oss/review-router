import { extractTicketIds, fetchTicketSummary } from "../src/jira";
import * as core from "@actions/core";

jest.mock("@actions/core");

describe("extractTicketIds", () => {
  it("extracts a single bracketed ticket ID", () => {
    expect(extractTicketIds("[APP-6000] Add proxy route")).toEqual(["APP-6000"]);
  });

  it("extracts multiple bracketed ticket IDs", () => {
    expect(extractTicketIds("[APP-100][APP-200] Fix two things")).toEqual([
      "APP-100",
      "APP-200",
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
    expect(extractTicketIds("APP-6000 Add proxy route")).toEqual([]);
  });
});

describe("fetchTicketSummary", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("returns the ticket summary on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ fields: { summary: "Migrate logs to DataVolt" } }),
    });
    const summary = await fetchTicketSummary("APP-6235", "https://acme.atlassian.net", "tok");
    expect(summary).toBe("Migrate logs to DataVolt");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://acme.atlassian.net/rest/api/3/issue/APP-6235?fields=summary",
      {
        headers: {
          Authorization: `Basic ${Buffer.from("tok").toString("base64")}`,
          Accept: "application/json",
        },
      }
    );
  });

  it("strips a trailing slash from base_url", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ fields: { summary: "x" } }),
    });
    await fetchTicketSummary("APP-1", "https://acme.atlassian.net/", "tok");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://acme.atlassian.net/rest/api/3/issue/APP-1?fields=summary",
      expect.anything()
    );
  });

  it("returns null and warns on 401", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const summary = await fetchTicketSummary("APP-6235", "https://acme.atlassian.net", "tok");
    expect(summary).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("401"));
  });

  it("returns null and warns on 404", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const summary = await fetchTicketSummary("APP-9999", "https://acme.atlassian.net", "tok");
    expect(summary).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("404"));
  });

  it("returns null and warns on network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const summary = await fetchTicketSummary("APP-6235", "https://acme.atlassian.net", "tok");
    expect(summary).toBeNull();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("returns null when summary field is absent", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ fields: {} }) });
    const summary = await fetchTicketSummary("APP-1", "https://acme.atlassian.net", "tok");
    expect(summary).toBeNull();
  });
});
