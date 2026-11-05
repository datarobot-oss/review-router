import { quotaLow, readQuota } from "../src/rate-limit";

function octokitWithCore(core: { remaining: number; limit: number } | Error) {
  return {
    rest: {
      rateLimit: {
        get: jest.fn(async () => {
          if (core instanceof Error) throw core;
          return { data: { resources: { core } } };
        }),
      },
    },
  } as never;
}

describe("readQuota", () => {
  it("returns the core remaining and limit", async () => {
    await expect(readQuota(octokitWithCore({ remaining: 4200, limit: 5000 }))).resolves.toEqual({
      remaining: 4200,
      limit: 5000,
    });
  });

  it("returns undefined when the endpoint fails", async () => {
    await expect(readQuota(octokitWithCore(new Error("boom")))).resolves.toBeUndefined();
  });

  it("returns undefined when the client has no rate limit endpoint", async () => {
    await expect(readQuota({} as never)).resolves.toBeUndefined();
  });
});

describe("quotaLow", () => {
  it("is low below 20 percent remaining", () => {
    expect(quotaLow({ remaining: 999, limit: 5000 })).toBe(true);
  });

  it("is not low at exactly 20 percent", () => {
    expect(quotaLow({ remaining: 1000, limit: 5000 })).toBe(false);
  });

  it("is not low with plenty left", () => {
    expect(quotaLow({ remaining: 4900, limit: 5000 })).toBe(false);
  });
});
