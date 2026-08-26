import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProviderUsageFetchers } from "../manifest.js";
import { OpenCodeGoQuotaProvider } from "./opencode-go.js";

function createLogger() {
  const logger = {
    debug: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger as never;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function writeOpenCodeAuth(credentialsDir: string, entry: unknown): string {
  const credentialsPath = join(credentialsDir, "auth.json");
  writeFileSync(credentialsPath, JSON.stringify({ "opencode-go": entry }));
  return credentialsPath;
}

describe("OpenCodeGoQuotaProvider", () => {
  it("maps rolling/weekly/monthly usage windows from the API key", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchApi: typeof fetch = async (input, init) => {
      requests.push({ url: input.toString(), init });
      return jsonResponse({
        usage: {
          rolling: { status: "ok", percent: 12, resetsAt: "2026-08-26T13:00:00.000Z" },
          weekly: { status: "ok", percent: 34, resetsAt: "2026-08-31T00:00:00.000Z" },
          monthly: { status: "ok", percent: 48, resetsAt: "2026-09-08T15:37:46.000Z" },
        },
      });
    };
    const provider = new OpenCodeGoQuotaProvider({
      logger: createLogger(),
      fetch: fetchApi,
      env: { OPENCODE_GO_API_KEY: "ocgo_test" },
    });

    await expect(provider.fetchUsage()).resolves.toEqual({
      providerId: "opencode-go",
      displayName: "OpenCode Go",
      status: "available",
      planLabel: null,
      windows: [
        {
          id: "session",
          label: "Session",
          usedPct: 12,
          remainingPct: 88,
          resetsAt: "2026-08-26T13:00:00.000Z",
          tone: "ok",
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 34,
          remainingPct: 66,
          resetsAt: "2026-08-31T00:00:00.000Z",
          tone: "ok",
        },
        {
          id: "monthly",
          label: "Monthly",
          usedPct: 48,
          remainingPct: 52,
          resetsAt: "2026-09-08T15:37:46.000Z",
          tone: "ok",
        },
      ],
      balances: [],
      details: [],
      error: null,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer ocgo_test",
      Accept: "application/json",
    });
    const userAgent = requests[0]?.init?.headers?.["User-Agent"];
    expect(typeof userAgent).toBe("string");
    expect(userAgent).toMatch(/Mozilla\/5\.0/);
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("marks a rate-limited window as danger regardless of percent", async () => {
    const provider = new OpenCodeGoQuotaProvider({
      logger: createLogger(),
      fetch: async () =>
        jsonResponse({
          usage: {
            rolling: { status: "rate-limited", percent: 100, resetsAt: "2026-08-26T14:00:00.000Z" },
            weekly: { status: "ok", percent: 5, resetsAt: "2026-08-31T00:00:00.000Z" },
          },
        }),
      env: { OPENCODE_GO_API_KEY: "ocgo_test" },
    });

    const usage = await provider.fetchUsage();
    expect(usage.windows).toMatchObject([
      { id: "session", tone: "danger", usedPct: 100 },
      { id: "weekly", tone: "ok", usedPct: 5 },
    ]);
    expect(usage.windows).toHaveLength(2);
  });

  it("reads the API key from the OpenCode auth file", async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), "opencode-go-credentials-"));
    const credentialsPath = writeOpenCodeAuth(credentialsDir, {
      type: "api",
      key: "ocgo_from_file",
    });
    let authHeader: string | undefined;
    const fetchApi: typeof fetch = async (input, init) => {
      authHeader = String(init?.headers?.Authorization);
      return jsonResponse({ usage: { rolling: { status: "ok", percent: 1 } } });
    };
    const provider = new OpenCodeGoQuotaProvider({
      logger: createLogger(),
      fetch: fetchApi,
      env: {},
      credentialsPath,
    });

    try {
      await provider.fetchUsage();
      expect(authHeader).toBe("Bearer ocgo_from_file");
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("prefers OPENCODE_GO_API_KEY over the auth file", async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), "opencode-go-pref-credentials-"));
    const credentialsPath = writeOpenCodeAuth(credentialsDir, { type: "api", key: "ocgo_file" });
    let usedKey: string | undefined;
    const fetchApi: typeof fetch = async (_input, init) => {
      usedKey = String(init?.headers?.Authorization);
      return jsonResponse({ usage: {} });
    };
    const provider = new OpenCodeGoQuotaProvider({
      logger: createLogger(),
      fetch: fetchApi,
      env: { OPENCODE_GO_API_KEY: "ocgo_env" },
      credentialsPath,
    });

    try {
      await provider.fetchUsage();
      expect(usedKey).toBe("Bearer ocgo_env");
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("does not call the API without a credential", async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), "opencode-go-empty-credentials-"));
    let called = false;
    const fetchApi: typeof fetch = async () => {
      called = true;
      return jsonResponse({});
    };
    const provider = new OpenCodeGoQuotaProvider({
      logger: createLogger(),
      fetch: fetchApi,
      env: {},
      credentialsPath: join(credentialsDir, "auth.json"),
    });

    try {
      await expect(provider.fetchUsage()).resolves.toEqual({
        providerId: "opencode-go",
        displayName: "OpenCode Go",
        status: "unavailable",
        planLabel: null,
        windows: [],
        balances: [],
        details: [],
        error: null,
      });
      expect(called).toBe(false);
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("returns unavailable on 401 without rewriting credentials", async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), "opencode-go-401-credentials-"));
    const credentialsPath = writeOpenCodeAuth(credentialsDir, {
      type: "api",
      key: "ocgo_revoked",
    });
    const fetchApi: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "AuthError" }), { status: 401 });
    const provider = new OpenCodeGoQuotaProvider({
      logger: createLogger(),
      fetch: fetchApi,
      env: {},
      credentialsPath,
    });

    try {
      await expect(provider.fetchUsage()).resolves.toMatchObject({ status: "unavailable" });
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("returns unavailable on 403 when the Go entitlement is missing", async () => {
    const provider = new OpenCodeGoQuotaProvider({
      logger: createLogger(),
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { type: "EntitlementError", message: "Go required." } }),
          { status: 403 },
        ),
      env: { OPENCODE_GO_API_KEY: "ocgo_no_sub" },
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({ status: "unavailable" });
  });

  it("returns unavailable when the usage fetch fails at the network layer", async () => {
    const provider = new OpenCodeGoQuotaProvider({
      logger: createLogger(),
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      env: { OPENCODE_GO_API_KEY: "ocgo_test" },
    });

    await expect(provider.fetchUsage()).resolves.toEqual({
      providerId: "opencode-go",
      displayName: "OpenCode Go",
      status: "unavailable",
      planLabel: null,
      windows: [],
      balances: [],
      details: [],
      error: null,
    });
  });

  it("registers OpenCode Go in the default daemon usage fetchers", () => {
    const fetchers = createProviderUsageFetchers({ logger: createLogger() });

    expect(fetchers.map((fetcher) => fetcher.providerId)).toContain("opencode-go");
  });
});
