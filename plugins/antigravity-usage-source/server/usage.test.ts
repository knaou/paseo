import { describe, expect, it } from "vitest";
import { AntigravityUsage } from "./usage.js";

const now = Date.parse("2026-10-12T14:00:00Z");
const path = "/home/test/.gemini/antigravity-cli/antigravity-oauth-token";
const credentials = {
  auth_method: "consumer",
  token: {
    access_token: "stored-access",
    refresh_token: "stored-refresh",
    expiry: "2026-10-12T15:00:00Z",
  },
};
// Shape observed from agy 1.3.3's retrieveUserQuotaSummary endpoint.
const quota = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          window: "weekly",
          remainingFraction: 0.8270296,
          resetTime: "2026-10-19T14:05:23Z",
        },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        {
          bucketId: "3p-weekly",
          window: "weekly",
          remainingFraction: 1,
          resetTime: "2026-10-19T14:21:01Z",
        },
      ],
    },
  ],
};

function harness(
  options: {
    store?: unknown;
    quota?: unknown;
    status?: number;
    refreshStatus?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const reads: string[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const usage = new AntigravityUsage({
    env: options.env ?? {
      ANTIGRAVITY_OAUTH_CLIENT_ID: "test-client-id",
      ANTIGRAVITY_OAUTH_CLIENT_SECRET: "test-client-secret",
    },
    home: () => "/home/test",
    now: () => now,
    read: async (file) => {
      reads.push(file);
      return JSON.stringify(options.store ?? credentials);
    },
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, init: init! });
      if (url.endsWith("/token"))
        return Response.json(
          { access_token: "refreshed-access", expires_in: 3600 },
          { status: options.refreshStatus ?? 200 },
        );
      if (options.status) return Response.json({}, { status: options.status });
      return Response.json(
        url.endsWith(":loadCodeAssist")
          ? {
              cloudaicompanionProject: "test-project",
              currentTier: { name: "Antigravity" },
              paidTier: { name: "Google AI Plus" },
            }
          : (options.quota ?? quota),
      );
    },
  });
  return { usage, reads, requests };
}

describe("Antigravity usage", () => {
  it("discovers the CLI login without exposing credentials in account input", async () => {
    const h = harness();
    const accounts = await h.usage.discover();
    expect(accounts).toEqual([
      { key: expect.stringMatching(/^[a-f0-9]{64}$/), harness: "Antigravity", input: { path } },
    ]);
    expect(h.reads).toEqual([path]);
    expect(h.requests).toEqual([]);
    expect(await h.usage.discover("/alternate")).toMatchObject([
      { input: { path: "/alternate/.gemini/antigravity-cli/antigravity-oauth-token" } },
    ]);
  });

  it("ignores malformed or absent login stores", async () => {
    expect(await harness({ store: {} }).usage.discover()).toEqual([]);
    const usage = new AntigravityUsage({
      read: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await usage.discover()).toEqual([]);
    await expect(usage.fetch({ path })).rejects.toThrow("login store no longer exists");
  });

  it("reports shared model-group quotas, paid plan and reset times", async () => {
    const h = harness();
    const report = await h.usage.fetch({ path });
    expect(report).toMatchObject({
      status: "available",
      planLabel: "Google AI Plus",
      windows: [
        {
          id: "gemini-weekly",
          label: "Gemini Models · weekly",
          usedPct: expect.closeTo(17.29704),
          remainingPct: expect.closeTo(82.70296),
          resetsAt: "2026-10-19T14:05:23Z",
          summary: true,
          tone: "ok",
        },
        { id: "3p-weekly", usedPct: 0, remainingPct: 100, tone: "ok" },
      ],
    });
    expect(h.requests.map((r) => JSON.parse(String(r.init.body)))).toEqual([
      { metadata: { ideType: "ANTIGRAVITY", ideVersion: "1.3.3", pluginType: "GEMINI" } },
      { project: "test-project" },
    ]);
    expect(h.requests[0]!.init.headers).toMatchObject({
      Authorization: "Bearer stored-access",
      "User-Agent": "antigravity/1.3.3",
    });
  });

  it("refreshes expiring consumer tokens once across concurrent requests and caches in memory", async () => {
    const h = harness({
      store: { ...credentials, token: { ...credentials.token, expiry: "2026-10-12T14:00:30Z" } },
    });
    await Promise.all([h.usage.fetch({ path }), h.usage.fetch({ path })]);
    await h.usage.fetch({ path });
    const refreshes = h.requests.filter((r) => r.url.endsWith("/token"));
    expect(refreshes).toHaveLength(1);
    const body = new URLSearchParams(String(refreshes[0]!.init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("stored-refresh");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(
      h.requests
        .filter((r) => !r.url.endsWith("/token"))
        .every(
          (r) => new Headers(r.init.headers).get("Authorization") === "Bearer refreshed-access",
        ),
    ).toBe(true);
  });

  it("reads valid stored tokens without OAuth client environment variables", async () => {
    const h = harness({ env: {} });
    expect(await h.usage.fetch({ path })).toMatchObject({ status: "available" });
    expect(h.requests.some((r) => r.url.endsWith("/token"))).toBe(false);
  });

  it.each([
    {},
    { ANTIGRAVITY_OAUTH_CLIENT_ID: "test-client-id" },
    { ANTIGRAVITY_OAUTH_CLIENT_SECRET: "test-client-secret" },
    { ANTIGRAVITY_OAUTH_CLIENT_ID: "   ", ANTIGRAVITY_OAUTH_CLIENT_SECRET: "test-client-secret" },
  ])("does not send a refresh request with missing OAuth client settings: %j", async (env) => {
    const h = harness({
      env,
      store: { ...credentials, token: { ...credentials.token, expiry: "2026-10-11T00:00:00Z" } },
    });
    await expect(h.usage.fetch({ path })).rejects.toThrow(
      "Set ANTIGRAVITY_OAUTH_CLIENT_ID and ANTIGRAVITY_OAUTH_CLIENT_SECRET",
    );
    expect(h.requests).toEqual([]);
  });

  it("reports expired credentials without a refresh token", async () => {
    const h = harness({
      store: { token: { access_token: "expired", expiry: "2026-10-11T00:00:00Z" } },
    });
    expect(await h.usage.fetch({ path })).toEqual({
      status: "unavailable",
      problem: { kind: "expired", expiresAt: "2026-10-11T00:00:00.000Z", refreshedBy: "agy" },
    });
    expect(h.requests).toEqual([]);
  });

  it("reports rejected authentication without response bodies or credentials", async () => {
    const h = harness({ status: 403 });
    expect(await h.usage.fetch({ path })).toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 403, refreshedBy: "agy" },
    });
    const expired = harness({
      store: { ...credentials, token: { ...credentials.token, expiry: "2026-10-11T00:00:00Z" } },
      refreshStatus: 400,
    });
    expect(await expired.usage.fetch({ path })).toMatchObject({
      status: "unavailable",
      problem: { kind: "rejected", status: 400 },
    });
  });

  it("deduplicates buckets and excludes disabled and non-percentage quotas", async () => {
    const h = harness({
      quota: {
        ...quota,
        buckets: [
          quota.groups[0]!.buckets[0],
          { bucketId: "disabled", remainingFraction: 0, disabled: true },
          { bucketId: "amount", remainingAmount: "100" },
          { bucketId: "daily", window: "daily", remainingFraction: 0 },
        ],
      },
    });
    expect(await h.usage.fetch({ path })).toMatchObject({
      windows: [
        { id: "gemini-weekly" },
        { id: "3p-weekly" },
        { id: "daily", usedPct: 100, remainingPct: 0, tone: "danger", resetsAt: null },
      ],
    });
    expect(await harness({ quota: {} }).usage.fetch({ path })).toMatchObject({
      status: "unavailable",
      problem: { kind: "no_quota" },
    });
  });

  it("rejects malformed API data and reports server errors separately from auth", async () => {
    await expect(
      harness({ quota: { buckets: [{ bucketId: "bad", remainingFraction: 4 }] } }).usage.fetch({
        path,
      }),
    ).rejects.toThrow();
    await expect(harness({ status: 500 }).usage.fetch({ path })).rejects.toThrow(
      "API returned 500",
    );
  });
});
