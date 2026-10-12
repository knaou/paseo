import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discover, fetchUsage } from "./usage.js";

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

const envInput = { store: "env", locator: "JUNIE_API_KEY" } as const;

describe("junie usage source", () => {
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

    await expect(
      fetchUsage(envInput, fetchApi, { env: { JUNIE_API_KEY: "perm_test" } }),
    ).resolves.toEqual({
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

  it("throws instead of calling the API without a Junie credential", async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), "junie-empty-credentials-"));
    let called = false;
    const fetchApi: typeof fetch = async () => {
      called = true;
      return jsonResponse({});
    };

    try {
      await expect(
        fetchUsage(
          { store: "file", locator: join(credentialsDir, "secure_credentials.json") },
          fetchApi,
        ),
      ).rejects.toThrow("Junie login store no longer exists");
      expect(called).toBe(false);
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("uses a configured monthly credit limit and reset day", async () => {
    const now = new Date(2026, 7, 26, 12);

    await expect(
      fetchUsage(
        envInput,
        async () =>
          jsonResponse({
            active: true,
            balanceLeft: 120_000,
            balanceUnit: "CREDITS",
          }),
        {
          env: {
            JUNIE_API_KEY: "perm_test",
            JUNIE_MONTHLY_CREDITS: "2",
            JUNIE_MONTHLY_CREDITS_RESET_DAY: "15",
          },
          now: () => now,
        },
      ),
    ).resolves.toMatchObject({
      status: "available",
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
    const report = await fetchUsage(
      envInput,
      async () =>
        jsonResponse({
          active: true,
          balanceLeft: 120_000,
          balanceUnit: "CREDITS",
        }),
      {
        env: {
          JUNIE_API_KEY: "perm_test",
          JUNIE_MONTHLY_CREDITS_RESET_DAY: "1",
        },
        now: () => now,
      },
    );

    expect(report.status).toBe("available");
    if (report.status !== "available") return;
    expect(report.balances).toHaveLength(1);
    expect(report.balances?.[0]).toMatchObject({
      id: "balance",
      label: "AI Credits",
      remaining: 1.2,
      unit: "credits",
      resetsAt: new Date(2026, 8, 1).toISOString(),
      tone: "ok",
    });
    expect(report.balances?.[0]).not.toHaveProperty("used");
    expect(report.balances?.[0]).not.toHaveProperty("limit");
  });

  it("redeems the stored multi-use refresh token when the access token is expired", async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), "junie-credentials-"));
    const originalAccount = {
      jbAccount: {
        access_token: expiredAccessToken(),
        refresh_token: "rt_junie_once",
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

    try {
      await expect(
        fetchUsage({ store: "file", locator: credentialsPath }, fetchApi, { env: {} }),
      ).resolves.toMatchObject({
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
        refresh_token: "rt_junie_reuse",
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

    try {
      await fetchUsage({ store: "file", locator: credentialsPath }, fetchApi, { env: {} });
      await fetchUsage({ store: "file", locator: credentialsPath }, fetchApi, { env: {} });
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
        refresh_token: "rt_junie_unused",
        expires_in: 1800,
      },
    });
    const requests: string[] = [];
    const fetchApi: typeof fetch = async (input) => {
      requests.push(input.toString());
      return jsonResponse({ active: true, balanceLeft: 120_000, balanceUnit: "CREDITS" });
    };

    try {
      await expect(
        fetchUsage({ store: "file", locator: credentialsPath }, fetchApi, { env: {} }),
      ).resolves.toMatchObject({ status: "available" });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toBe("https://ingrazzio-cloud-prod.labs.jb.gg/auth/test");
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("reports an unavailable login when the refresh grant is rejected", async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), "junie-credentials-"));
    const credentialsPath = writeJunieCredentials(credentialsDir, {
      jbAccount: {
        access_token: expiredAccessToken(),
        refresh_token: "rt_junie_revoked",
        expires_in: 900,
      },
    });
    const requests: string[] = [];
    const fetchApi: typeof fetch = async (input) => {
      requests.push(input.toString());
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    };

    try {
      await expect(
        fetchUsage({ store: "file", locator: credentialsPath }, fetchApi, { env: {} }),
      ).resolves.toEqual({ status: "unavailable", problem: { kind: "rejected", status: 400 } });
      expect(requests).toEqual(["https://oauth.account.jetbrains.com/oauth2/token"]);
    } finally {
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("reports a rejected login when the usage API denies the token", async () => {
    await expect(
      fetchUsage(envInput, async () => new Response(null, { status: 403 }), {
        env: { JUNIE_API_KEY: "perm_denied" },
      }),
    ).resolves.toEqual({ status: "unavailable", problem: { kind: "rejected", status: 403 } });
  });

  it("reports no quota when the account has no active license", async () => {
    await expect(
      fetchUsage(envInput, async () => jsonResponse({ active: false, balanceLeft: 0 }), {
        env: { JUNIE_API_KEY: "perm_test" },
      }),
    ).resolves.toEqual({
      status: "unavailable",
      problem: { kind: "no_quota", detail: "No active Junie license" },
    });
  });

  it("propagates a usage API failure for the daemon to report as an error", async () => {
    await expect(
      fetchUsage(
        envInput,
        async () => {
          throw new TypeError("fetch failed");
        },
        { env: { JUNIE_API_KEY: "perm_test" } },
      ),
    ).rejects.toThrow("fetch failed");
  });

  it("discovers a Junie API key before the credential file", async () => {
    const previous = process.env.JUNIE_API_KEY;
    const previousHome = process.env.JUNIE_HOME;
    const credentialsDir = mkdtempSync(join(tmpdir(), "junie-discover-"));
    writeJunieCredentials(credentialsDir, {
      jbAccount: { access_token: unexpiredAccessToken(1800) },
    });
    try {
      process.env.JUNIE_HOME = credentialsDir;
      expect(await discover()).toEqual([
        {
          key: "default",
          input: { store: "file", locator: join(credentialsDir, "secure_credentials.json") },
        },
      ]);
      process.env.JUNIE_API_KEY = "perm_test";
      expect(await discover()).toEqual([{ key: "default", input: envInput }]);
    } finally {
      if (previous === undefined) delete process.env.JUNIE_API_KEY;
      else process.env.JUNIE_API_KEY = previous;
      if (previousHome === undefined) delete process.env.JUNIE_HOME;
      else process.env.JUNIE_HOME = previousHome;
      rmSync(credentialsDir, { recursive: true, force: true });
    }
  });

  it("discovers no account without Junie credentials", async () => {
    const previousKey = process.env.JUNIE_API_KEY;
    const previousHome = process.env.JUNIE_HOME;
    try {
      delete process.env.JUNIE_API_KEY;
      process.env.JUNIE_HOME = mkdtempSync(join(tmpdir(), "junie-none-"));
      expect(await discover()).toEqual([]);
    } finally {
      if (previousKey === undefined) delete process.env.JUNIE_API_KEY;
      else process.env.JUNIE_API_KEY = previousKey;
      if (previousHome === undefined) delete process.env.JUNIE_HOME;
      else process.env.JUNIE_HOME = previousHome;
    }
  });
});
