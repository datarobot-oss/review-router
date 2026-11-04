import {
  addCompatibility,
  badgeUrl,
  fetchCompatibility,
  resetCompatibilityBreaker,
} from "../../src/gate/compat";
import { DependencyFacts } from "../../src/gate/dependabot";

jest.mock("@actions/core");

const dep = (over: Partial<DependencyFacts> = {}): DependencyFacts => ({
  name: "pypdf",
  ecosystem: "pip",
  dependencyType: "direct:production",
  version: "6.21.4",
  previous: "6.21.2",
  ...over,
});

beforeEach(() => resetCompatibilityBreaker());

const svg = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="compatibility: ${label}"><title>compatibility: ${label}</title></svg>`;

const respond = (body: string, ok = true) =>
  jest.fn().mockResolvedValue({ ok, text: async () => body });

describe("badgeUrl", () => {
  it("builds the lookup on the Dependabot badge host from the dependency and its versions", () => {
    const url = new URL(badgeUrl(dep()) as string);
    expect(url.origin).toBe("https://dependabot-badges.githubapp.com");
    expect(url.pathname).toBe("/badges/compatibility_score");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "dependency-name": "pypdf",
      "package-manager": "pip",
      "previous-version": "6.21.2",
      "new-version": "6.21.4",
    });
  });

  it("keeps a scoped name intact through the encoding", () => {
    const url = new URL(
      badgeUrl(dep({ name: "@aws-sdk/client-s3", ecosystem: "npm_and_yarn" })) as string
    );
    expect(url.searchParams.get("dependency-name")).toBe("@aws-sdk/client-s3");
  });

  it("asks the badge service for uv and Go packages under their own names", () => {
    const manager = (ecosystem: string) =>
      new URL(badgeUrl(dep({ ecosystem })) as string).searchParams.get("package-manager");
    expect(manager("uv")).toBe("uv");
    expect(manager("go_modules")).toBe("go_modules");
    expect(manager("npm_and_yarn")).toBe("npm_and_yarn");
  });

  it("can't encode a name into another host or parameter", () => {
    const url = new URL(badgeUrl(dep({ name: "x&package-manager=evil#@evil.example/" })) as string);
    expect(url.host).toBe("dependabot-badges.githubapp.com");
    expect(url.searchParams.get("package-manager")).toBe("pip");
  });

  it("builds nothing when a version is missing", () => {
    expect(badgeUrl(dep({ previous: undefined }))).toBeUndefined();
    expect(badgeUrl(dep({ version: undefined }))).toBeUndefined();
  });
});

describe("fetchCompatibility", () => {
  it("reads the score from the badge", async () => {
    expect(await fetchCompatibility(dep(), respond(svg("82%")))).toBe(82);
    expect(await fetchCompatibility(dep(), respond(svg("100%")))).toBe(100);
    expect(await fetchCompatibility(dep(), respond(svg("0%")))).toBe(0);
  });

  it("returns nothing for an unknown score", async () => {
    expect(await fetchCompatibility(dep(), respond(svg("unknown")))).toBeUndefined();
  });

  it("returns nothing for an answer that is not a badge", async () => {
    expect(await fetchCompatibility(dep(), respond("<html>hello</html>"))).toBeUndefined();
    expect(await fetchCompatibility(dep(), respond(svg("150%")))).toBeUndefined();
  });

  it("returns nothing when the service answers with an error", async () => {
    expect(await fetchCompatibility(dep(), respond(svg("82%"), false))).toBeUndefined();
  });

  it("returns nothing when the request fails or times out", async () => {
    expect(
      await fetchCompatibility(dep(), jest.fn().mockRejectedValue(new Error("offline")))
    ).toBeUndefined();
  });

  it("makes no request without both versions", async () => {
    const fetchFn = respond(svg("82%"));
    expect(await fetchCompatibility(dep({ previous: undefined }), fetchFn)).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("asks only the badge host, with a timeout", async () => {
    const fetchFn = respond(svg("82%"));
    await fetchCompatibility(dep(), fetchFn);
    const [url, init] = fetchFn.mock.calls[0];
    expect(new URL(url).host).toBe("dependabot-badges.githubapp.com");
    expect(init.signal).toBeDefined();
  });

  it("refuses a redirect, so the answer can only come from the badge host", async () => {
    const fetchFn = respond(svg("82%"));
    await fetchCompatibility(dep(), fetchFn);
    expect(fetchFn.mock.calls[0][1].redirect).toBe("error");
  });

  it("stops asking after three failed requests in a row, so a dead host costs seconds, not minutes", async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error("timeout"));
    for (let i = 0; i < 5; i++) await fetchCompatibility(dep(), fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not count an unknown score or an error status as a failure of the host", async () => {
    const fetchFn = respond(svg("unknown"));
    for (let i = 0; i < 5; i++) await fetchCompatibility(dep(), fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    const failing = respond("", false);
    for (let i = 0; i < 5; i++) await fetchCompatibility(dep(), failing);
    expect(failing).toHaveBeenCalledTimes(5);
  });

  it("starts counting again after an answer", async () => {
    const fetchFn = jest
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ ok: true, text: async () => svg("80%") })
      .mockRejectedValue(new Error("timeout"));
    for (let i = 0; i < 6; i++) await fetchCompatibility(dep(), fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });
});

describe("addCompatibility", () => {
  it("adds the score of every dependency, keeping the order", async () => {
    const fetchFn = jest.fn(async (url: string) => ({
      ok: true,
      text: async () =>
        svg(new URL(url).searchParams.get("dependency-name") === "a" ? "90%" : "75%"),
    }));
    const result = await addCompatibility([dep({ name: "a" }), dep({ name: "b" })], fetchFn);
    expect(result.map((d) => [d.name, d.compatibility])).toEqual([
      ["a", 90],
      ["b", 75],
    ]);
  });

  it("leaves a dependency without a score when its lookup fails, and keeps the others", async () => {
    const fetchFn = jest
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true, text: async () => svg("90%") });
    const result = await addCompatibility([dep({ name: "a" }), dep({ name: "b" })], fetchFn);
    expect(result.map((d) => d.compatibility)).toEqual([undefined, 90]);
  });

  it("looks up at most 30 dependencies and leaves the rest without a score", async () => {
    const fetchFn = respond(svg("90%"));
    const many = Array.from({ length: 35 }, (_, i) => dep({ name: `p${i}` }));
    const result = await addCompatibility(many, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(30);
    expect(result.filter((d) => d.compatibility === 90)).toHaveLength(30);
    expect(result[34].compatibility).toBeUndefined();
  });

  it("returns an empty list for no dependency", async () => {
    expect(await addCompatibility([], respond(svg("90%")))).toEqual([]);
  });
});
