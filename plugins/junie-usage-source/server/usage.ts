import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageInput } from "../shared/input.js";
import { z } from "zod";
import {
  balanceToneFromRemaining,
  toneFromUsedPct,
  unavailable,
  usedPctOf,
  type UsageAccount,
  type UsageBalance,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";

const JUNIE_USAGE_URL = "https://ingrazzio-cloud-prod.labs.jb.gg/auth/test";
const JUNIE_TOKEN_URL = "https://oauth.account.jetbrains.com/oauth2/token";
const JUNIE_OAUTH_CLIENT_ID = "junie-cli";
const JUNIE_AI_CREDIT_SCALE = 100_000;
const JUNIE_TOKEN_EXPIRY_MARGIN_MS = 60_000;
const JUNIE_RELEASE_LICENSE_HEADERS = {
  "X-Accept-EAP-License": "false",
  "X-Accept-Release-License": "true",
} as const;

const ApiNullableNumberSchema = z.coerce.number().finite().nullish();
const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

const JunieUsageResponseSchema = z.object({
  active: z.boolean().nullish(),
  balanceLeft: ApiNullableNumberSchema.optional(),
  balanceUnit: ApiOptionalStringSchema,
  licenseType: ApiOptionalStringSchema,
});

const JunieTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: ApiNullableNumberSchema.optional(),
});

const JunieCredentialsFileSchema = z.object({
  secrets: z.array(
    z.object({
      key: z.string(),
      secret: z.string(),
    }),
  ),
});

const JunieStoredAccountSchema = z.object({
  simpleToken: z.string().nullish(),
  jbAccount: z
    .object({
      access_token: z.string().nullish(),
      refresh_token: z.string().nullish(),
    })
    .nullish(),
});

type JunieStoredAccount = z.infer<typeof JunieStoredAccountSchema>;

interface JunieStoredCredentials {
  simpleToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
}

interface JunieCachedToken {
  accessToken: string;
  expiresAtMs: number | null;
}

export interface JunieFetchOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/**
 * Refreshed access tokens cached per refresh token. Junie's stored access token
 * expires after an hour and the CLI never rewrites the credential file: both the
 * CLI and this fetcher redeem the file's multi-use refresh token independently.
 * The rotated refresh token from the response is discarded on purpose — the
 * on-disk token keeps working and the file stays untouched.
 */
const refreshedTokens = new Map<string, JunieCachedToken>();

function balanceUnit(value: string | undefined): UsageBalance["unit"] | null {
  switch (value?.trim().toLowerCase()) {
    case "usd":
    case "dollar":
    case "dollars":
      return "usd";
    case "credit":
    case "credits":
      return "credits";
    case "request":
    case "requests":
      return "requests";
    case "token":
    case "tokens":
      return "tokens";
    default:
      return null;
  }
}

function aiCreditsFromRawBalance(rawBalance: number): number {
  // Junie's release CLI presents CREDITS from /auth/test in units of 100,000.
  return Number((rawBalance / JUNIE_AI_CREDIT_SCALE).toFixed(2));
}

function configuredMonthlyCredits(env: NodeJS.ProcessEnv): number | null {
  const value = Number(env["JUNIE_MONTHLY_CREDITS"]?.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

function configuredMonthlyResetDay(env: NodeJS.ProcessEnv): number | null {
  const value = Number(env["JUNIE_MONTHLY_CREDITS_RESET_DAY"]?.trim());
  return Number.isInteger(value) && value >= 1 && value <= 31 ? value : null;
}

function resetAtForMonth(year: number, month: number, day: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

function nextMonthlyResetAt(day: number, now: Date): string | null {
  if (!Number.isFinite(now.getTime())) return null;

  const thisMonth = resetAtForMonth(now.getFullYear(), now.getMonth(), day);
  const next =
    thisMonth.getTime() > now.getTime()
      ? thisMonth
      : resetAtForMonth(now.getFullYear(), now.getMonth() + 1, day);
  return next.toISOString();
}

function accessTokenExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (decoded === null || typeof decoded !== "object" || !("exp" in decoded)) return null;
    const exp = (decoded as { exp: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["JUNIE_HOME"]?.trim() || join(homedir(), ".junie"), "secure_credentials.json");
}

async function readStoredCredentials(
  path: string,
): Promise<{ stored: JunieStoredCredentials } | null> {
  if (!existsSync(path)) return null;

  try {
    const credentials = JunieCredentialsFileSchema.parse(
      JSON.parse(await fs.readFile(path, "utf8")),
    );
    const stored = credentials.secrets.find((secret) => secret.key === "jb-account-stored");
    if (!stored) return null;

    const account: JunieStoredAccount = JunieStoredAccountSchema.parse(JSON.parse(stored.secret));
    return {
      stored: {
        simpleToken: account.simpleToken?.trim() || null,
        accessToken: account.jbAccount?.access_token?.trim() || null,
        refreshToken: account.jbAccount?.refresh_token?.trim() || null,
      },
    };
  } catch {
    return null;
  }
}

type JunieRefreshOutcome =
  | { kind: "token"; accessToken: string; expiresAtMs: number | null }
  | { kind: "rejected"; status: number }
  | { kind: "failed" };

async function refreshAccessToken(
  refreshToken: string,
  fetchApi: typeof fetch,
  now: Date,
): Promise<JunieRefreshOutcome> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: JUNIE_OAUTH_CLIENT_ID,
  });

  try {
    const res = await fetchApi(JUNIE_TOKEN_URL, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
    if (!res.ok) return { kind: "rejected", status: res.status };

    const token = JunieTokenResponseSchema.parse(await res.json());
    const expiresInMs = typeof token.expires_in === "number" ? token.expires_in * 1000 : null;
    return {
      kind: "token",
      accessToken: token.access_token,
      expiresAtMs:
        expiresInMs === null ? null : now.getTime() + expiresInMs - JUNIE_TOKEN_EXPIRY_MARGIN_MS,
    };
  } catch {
    return { kind: "failed" };
  }
}

type JunieResolvedToken =
  | { ok: true; token: string }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "rejected"; status: number };

async function resolveAccessToken(
  path: string,
  fetchApi: typeof fetch,
  now: Date,
): Promise<JunieResolvedToken> {
  const credentials = await readStoredCredentials(path);
  if (!credentials) return { ok: false, reason: "missing" };
  if (credentials.stored.simpleToken) return { ok: true, token: credentials.stored.simpleToken };

  const expiryMs =
    credentials.stored.accessToken === null
      ? 0
      : accessTokenExpiryMs(credentials.stored.accessToken);
  if (
    credentials.stored.accessToken !== null &&
    (expiryMs === null || expiryMs > now.getTime() + JUNIE_TOKEN_EXPIRY_MARGIN_MS)
  ) {
    return { ok: true, token: credentials.stored.accessToken };
  }

  const refreshToken = credentials.stored.refreshToken;
  if (refreshToken === null) return { ok: false, reason: "missing" };

  const cached = refreshedTokens.get(refreshToken);
  if (cached && (cached.expiresAtMs === null || cached.expiresAtMs > now.getTime())) {
    return { ok: true, token: cached.accessToken };
  }

  const refreshed = await refreshAccessToken(refreshToken, fetchApi, now);
  if (refreshed.kind === "rejected")
    return { ok: false, reason: "rejected", status: refreshed.status };
  if (refreshed.kind !== "token") return { ok: false, reason: "missing" };
  refreshedTokens.set(refreshToken, {
    accessToken: refreshed.accessToken,
    expiresAtMs: refreshed.expiresAtMs,
  });
  return { ok: true, token: refreshed.accessToken };
}

function usageBalances(
  usage: z.infer<typeof JunieUsageResponseSchema>,
  env: NodeJS.ProcessEnv,
  now: Date,
): UsageBalance[] {
  const unit = balanceUnit(usage.balanceUnit);
  if (usage.balanceLeft === undefined || usage.balanceLeft === null || unit === null) return [];

  const remaining =
    unit === "credits" ? aiCreditsFromRawBalance(usage.balanceLeft) : usage.balanceLeft;
  const monthlyCredits = unit === "credits" ? configuredMonthlyCredits(env) : null;
  const used = monthlyCredits === null ? null : Math.max(0, monthlyCredits - remaining);
  const resetDay = configuredMonthlyResetDay(env);
  const resetsAt = resetDay === null ? null : nextMonthlyResetAt(resetDay, now);
  return [
    {
      id: "balance",
      label: unit === "credits" ? "AI Credits" : "Balance",
      ...(monthlyCredits === null ? {} : { used, limit: monthlyCredits }),
      ...(resetsAt === null ? {} : { resetsAt }),
      remaining,
      unit,
      tone:
        monthlyCredits === null
          ? balanceToneFromRemaining(remaining)
          : toneFromUsedPct(usedPctOf(used, monthlyCredits)),
    },
  ];
}

async function tokenFromStore(
  input: UsageInput,
  fetchApi: typeof fetch,
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<{ token: string } | { report: UsageReport }> {
  if (input.store === "env") return { token: env[input.locator]?.trim() ?? "" };

  const resolved = await resolveAccessToken(input.locator, fetchApi, now);
  if (resolved.ok) return { token: resolved.token };
  if (resolved.reason === "rejected")
    return { report: unavailable({ kind: "rejected", status: resolved.status }) };
  throw new Error("Junie login store no longer exists");
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
  options: JunieFetchOptions = {},
): Promise<UsageReport> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  const outcome = await tokenFromStore(input, fetchApi, env, now());
  if ("report" in outcome) return outcome.report;
  if (!outcome.token) throw new Error("Junie login store no longer exists");

  const res = await fetchApi(JUNIE_USAGE_URL, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${outcome.token}`,
      Accept: "application/json",
      ...JUNIE_RELEASE_LICENSE_HEADERS,
    },
  });

  if (res.status === 401 || res.status === 403)
    return unavailable({ kind: "rejected", status: res.status });
  if (!res.ok) throw new Error(`Junie usage API returned ${res.status}`);

  const usage = JunieUsageResponseSchema.parse(await res.json());
  if (usage.active === false)
    return unavailable({ kind: "no_quota", detail: "No active Junie license" });

  return {
    status: "available",
    planLabel: usage.licenseType?.trim() || undefined,
    windows: [],
    balances: usageBalances(usage, env, now()),
    details: [],
  };
}

export async function discover(env: NodeJS.ProcessEnv = process.env): Promise<UsageAccount[]> {
  if (env["JUNIE_API_KEY"]?.trim()) {
    return [{ key: "default", input: { store: "env", locator: "JUNIE_API_KEY" } }];
  }

  const path = credentialsPath(env);
  const credentials = await readStoredCredentials(path);
  if (
    credentials &&
    (credentials.stored.simpleToken ||
      credentials.stored.accessToken ||
      credentials.stored.refreshToken)
  ) {
    return [{ key: "default", input: { store: "file", locator: path } }];
  }
  return [];
}
