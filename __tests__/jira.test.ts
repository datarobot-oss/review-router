import { extractTicketIds } from "../src/jira";

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
