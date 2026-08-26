import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProviderUsageFetchers } from "../manifest.js";
import { JunieQuotaProvider } from "./junie.js";

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

function expiredAccessToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: 0 })).toString("base64url");
  return `header.${payload}.signature`;
}

function unexpiredAccessToken(expiresInSeconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function writeJunieCredentials(credentialsDir: string, account: unknown): string {
  const credentialsPath = join(credentialsDir, "secure_credentials.json");
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      secrets: [{ key: "jb-account-stored", secret: JSON.stringify(account) }],
    }),
  );
  return credentialsPath;
}

describe("JunieQuotaProvider", () => {
  it("uses Junie's release allocation and normalizes AI Credits for a Junie API key", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchApi: typeof fetch = async (input, init) => {
      requests.push({ url: input.toString(), init });
      return jsonResponse({
        active: true,
        balanceLeft: 120_000,
        balanceUnit: "CREDITS",
        licenseType: "AIP",
      });
    };
    const provider = new JunieQuotaProvider({
      logger: createLogger(),
      fetch: fetchApi,
      env: { JUNIE_API_KEY: "perm_test" },
    });

    await expect(provider.fetchUsage()).resolves.toEqual({
      providerId: "junie",
      displayName: "Junie",
      status: "available",
      planLabel: "AIP",
      windows: [],
      balances: [
        {
          id: "balance",
          label: "AI Credits",
          remaining: 1.2,
          unit: "credits",
          tone: "ok",
        },
      ],
      details: [],
      error: null,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://ingrazzio-cloud-prod.labs.jb.gg/auth/test");
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer perm_test",
      Accept: "application/json",
      "X-Accept-EAP-License": "false",
      "X-Accept-Release-License": "true",
    });
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not call the API without a Junie credential", async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), "junie-empty-credentials-"));
    let called = false;
    const fetchApi: typeof fetch = async () => {
      called = true;
      return jsonResponse({});
    };
    const provider = new JunieQuotaProvider({
      logger: createLogger(),
      fetch: fetchApi,
      env: {},
      credentialsPath: join(credentialsDir, "secure_credentials.json"),
    });

    try {
      await expect(provider.fetchUsage()).resolves.toEqual({
        providerId: "junie",
        displayName: "Junie",
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

  it("uses a configured monthly credit limit and reset day", async () => {
    const now = new Date(2026, 7, 26, 12);
    const provider = new JunieQuotaProvider({
      logger: createLogger(),
      fetch: async () =>
        jsonResponse({
          active: true,
          balanceLeft: 120_000,
          balanceUnit: "CREDITS",
        }),
      env: {
        JUNIE_API_KEY: "perm_test",
        JUNIE_MONTHLY_CREDITS: "2",
        JUNIE_MONTHLY_CREDITS_RESET_DAY: "15",
      },
      now: () => now,
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      balances: [
        {
          id: "balance",
          label: "AI Credits",
          used: 0.8,
          remaining: 1.2,
          limit: 2,
          unit: "credits",
          resetsAt: new Date(2026, 8, 15).toISOString(),
          tone: "ok",
        },
      ],
    });
  });

  it("shows the next reset from JUNIE_MONTHLY_CREDITS_RESET_DAY without a credit limit", async () => {
    const now = new Date(2026, 7, 26, 12);
    const provider = new JunieQuotaProvider({
      logger: createLogger(),
      fetch: async () =>
        jsonResponse({
          active: true,
          balanceLeft: 120_000,
          balanceUnit: "CREDITS",
        }),
      env: {
        JUNIE_API_KEY: "perm_test",
        JUNIE_MONTHLY_CREDITS_RESET_DAY: "1",
      },
      now: () => now,
    });

    const usage = await provider.fetchUsage();
    expect(usage.balances).toHaveLength(1);
    expect(usage.balances[0]).toMatchObject({
      id: "balance",
      label: "AI Credits",
      remaining: 1.2,
      unit: "credits",
      resetsAt: new Date(2026, 8, 1).toISOString(),
      tone: "ok",
    });
    expect(usage.balances[0]).not.toHaveProperty("used");
    expect(usage.balances[0]).not.toHaveProperty("limit");
  });

  it("redeems the stored multi-use refresh token when the access token is expired", async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), "junie-credentials-"));
    const originalAccount = {
      jbAccount: {
        access_token: expiredAccessToken(),
        refresh_token: "rt_junie",
        expires_in: 900,
      },
    };
    const credentialsPath = writeJunieCredentials(credentialsDir, originalAccount);
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchApi: typeof fetch = async (input, init) => {
      requests.push({ url: input.toString(), init });
      if (input.toString() === "https://oauth.account.jetbrains.com/oauth2/token") {
        return jsonResponse({
          access_token: "fresh_token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return jsonResponse({
        active: true,
        balanceLeft: 119_854.7455,
        balanceUnit: "CREDITS",
        licenseType: "AIP",
      });
    };
    const provider = new JunieQuotaProvider({
      logger: createLogger(),
      fetch: fetchApi,
      env: {},
      credentialsPath,
    });

    try {
      await expect(provider.fetchUsage()).resolves.toMatchObject({
        status: "available",
        planLabel: "AIP",
        balances: [
          {
            id: "balance",
            label: "AI Credits",
            remaining: 1.2,
            unit: "credits",
            tone: "ok",
          },
        ],
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.url).toBe("https://oauth.account.jetbrains.com/oauth2/token");
      expect(requests[0]?.init?.method).toBe("POST");
      expect(String(requests[0]?.init?.headers?.["Content-Type"])).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(String(requests[0]?.init?.body)).toContain("grant_type=refresh_token");
      expect(String(requests[0]?.init?.body)).toContain("client_id=junie-cli");
      expect(requests[1]?.url).toBe("https://ingrazzio-cloud-prod.labs.jb.gg/auth/test");
      expect(requests[1]?.init?.headers).toMatchObject({
        Authorization: "Bearer fresh_token",
      });

      const after = JSON.parse(readFileSync(credentialsPath, "utf8"));
      expect(JSON.parse(after.secrets[0].secret)).toEqual(originalAccount);
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("reuses the refreshed access token across fetches without redeeming again", async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), "junie-credentials-"));
    const credentialsPath = writeJunieCredentials(credentialsDir, {
      jbAccount: {
        access_token: expiredAccessToken(),
        refresh_token: "rt_junie",
        expires_in: 900,
      },
    });
    const requests: string[] = [];
    const fetchApi: typeof fetch = async (input) => {
      requests.push(input.toString());
      if (input.toString() === "https://oauth.account.jetbrains.com/oauth2/token") {
        return jsonResponse({
          access_token: "fresh_token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return jsonResponse({ active: true, balanceLeft: 120_000, balanceUnit: "CREDITS" });
    };
    const provider = new JunieQuotaProvider({
      logger: createLogger(),
      fetch: fetchApi,
      env: {},
      credentialsPath,
    });

    try {
      await provider.fetchUsage();
      await provider.fetchUsage();
      expect(requests.filter((url) => url.endsWith("/oauth2/token"))).toHaveLength(1);
      expect(requests.filter((url) => url.endsWith("/auth/test"))).toHaveLength(2);
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("uses a stored unexpired access token without refreshing", async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), "junie-credentials-"));
    const credentialsPath = writeJunieCredentials(credentialsDir, {
      jbAccount: {
        access_token: unexpiredAccessToken(1800),
        refresh_token: "rt_junie",
        expires_in: 1800,
      },
    });
    const requests: string[] = [];
    const fetchApi: typeof fetch = async (input) => {
      requests.push(input.toString());
      return jsonResponse({ active: true, balanceLeft: 120_000, balanceUnit: "CREDITS" });
    };
    const provider = new JunieQuotaProvider({
      logger: createLogger(),
      fetch: fetchApi,
      env: {},
      credentialsPath,
    });

    try {
      await expect(provider.fetchUsage()).resolves.toMatchObject({ status: "available" });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toBe("https://ingrazzio-cloud-prod.labs.jb.gg/auth/test");
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("returns unavailable when the refresh grant is rejected", async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), "junie-credentials-"));
    const credentialsPath = writeJunieCredentials(credentialsDir, {
      jbAccount: {
        access_token: expiredAccessToken(),
        refresh_token: "rt_revoked",
        expires_in: 900,
      },
    });
    const requests: string[] = [];
    const fetchApi: typeof fetch = async (input) => {
      requests.push(input.toString());
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    };
    const provider = new JunieQuotaProvider({
      logger: createLogger(),
      fetch: fetchApi,
      env: {},
      credentialsPath,
    });

    try {
      await expect(provider.fetchUsage()).resolves.toMatchObject({ status: "unavailable" });
      expect(requests).toEqual(["https://oauth.account.jetbrains.com/oauth2/token"]);
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("returns unavailable when the Junie usage request fails at the network layer", async () => {
    const provider = new JunieQuotaProvider({
      logger: createLogger(),
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      env: { JUNIE_API_KEY: "perm_test" },
    });

    await expect(provider.fetchUsage()).resolves.toEqual({
      providerId: "junie",
      displayName: "Junie",
      status: "unavailable",
      planLabel: null,
      windows: [],
      balances: [],
      details: [],
      error: null,
    });
  });

  it("registers Junie in the default daemon usage fetchers", () => {
    const fetchers = createProviderUsageFetchers({ logger: createLogger() });

    expect(fetchers.map((fetcher) => fetcher.providerId)).toContain("junie");
  });
});
