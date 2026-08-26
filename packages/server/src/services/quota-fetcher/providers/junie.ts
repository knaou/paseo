import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageBalance } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNullableNumberSchema,
  ApiOptionalStringSchema,
  balanceToneFromRemaining,
  fetchProviderApi,
  toneFromUsedPct,
  unavailableUsage,
  usedPctOf,
} from "../usage.js";

const JUNIE_USAGE_URL = "https://ingrazzio-cloud-prod.labs.jb.gg/auth/test";
const JUNIE_TOKEN_URL = "https://oauth.account.jetbrains.com/oauth2/token";
const JUNIE_OAUTH_CLIENT_ID = "junie-cli";
const JUNIE_AI_CREDIT_SCALE = 100_000;
const JUNIE_TOKEN_EXPIRY_MARGIN_MS = 60_000;
const JUNIE_RELEASE_LICENSE_HEADERS = {
  "X-Accept-EAP-License": "false",
  "X-Accept-Release-License": "true",
} as const;

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

interface JunieStoredCredentials {
  simpleToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
}

interface JunieRefreshedToken {
  accessToken: string;
  expiresAtMs: number | null;
}

interface JunieQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  now?: () => Date;
}

function balanceUnit(value: string | undefined): ProviderUsageBalance["unit"] | null {
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

export class JunieQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "junie";
  readonly displayName = "Junie";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly credentialsPath: string;
  private readonly now: () => Date;
  private refreshed: JunieRefreshedToken | null = null;

  constructor(options: JunieQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
    this.credentialsPath =
      options.credentialsPath ??
      join(this.env["JUNIE_HOME"]?.trim() || join(homedir(), ".junie"), "secure_credentials.json");
    this.now = options.now ?? (() => new Date());
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token = this.env["JUNIE_API_KEY"]?.trim() || (await this.resolveAccessToken());
    if (!token) return unavailableUsage(this);

    let res: Response;
    try {
      res = await fetchProviderApi(this.fetchApi, JUNIE_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...JUNIE_RELEASE_LICENSE_HEADERS,
        },
      });
    } catch (err) {
      this.logger.debug({ err }, "Junie usage fetch failed");
      return unavailableUsage(this);
    }

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Junie usage fetch failed");
      return unavailableUsage(this);
    }

    const usage = JunieUsageResponseSchema.parse(await res.json());
    const unit = balanceUnit(usage.balanceUnit);
    const balances: ProviderUsageBalance[] = [];
    if (usage.balanceLeft !== undefined && usage.balanceLeft !== null && unit !== null) {
      const remaining =
        unit === "credits" ? aiCreditsFromRawBalance(usage.balanceLeft) : usage.balanceLeft;
      const monthlyCredits = unit === "credits" ? configuredMonthlyCredits(this.env) : null;
      const used = monthlyCredits === null ? null : Math.max(0, monthlyCredits - remaining);
      const resetDay = configuredMonthlyResetDay(this.env);
      const resetsAt = resetDay === null ? null : nextMonthlyResetAt(resetDay, this.now());
      balances.push({
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
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: usage.active === false ? "unavailable" : "available",
      planLabel: usage.licenseType?.trim() || null,
      windows: [],
      balances,
      details: [],
      error: null,
    };
  }

  /**
   * Junie's stored access token expires after an hour and the CLI never rewrites the
   * credential file: both the CLI and this fetcher redeem the file's multi-use refresh
   * token independently. The rotated refresh token from the response is discarded on
   * purpose — the on-disk token keeps working and the file stays untouched.
   */
  private async resolveAccessToken(): Promise<string | null> {
    const nowMs = this.now().getTime();
    if (
      this.refreshed?.accessToken &&
      (this.refreshed.expiresAtMs === null ||
        this.refreshed.expiresAtMs > nowMs + JUNIE_TOKEN_EXPIRY_MARGIN_MS)
    ) {
      return this.refreshed.accessToken;
    }
    this.refreshed = null;

    const stored = await this.readStoredCredentials();
    if (!stored) return null;
    if (stored.simpleToken) return stored.simpleToken;

    const expiryMs = stored.accessToken === null ? 0 : accessTokenExpiryMs(stored.accessToken);
    if (
      stored.accessToken !== null &&
      (expiryMs === null || expiryMs > nowMs + JUNIE_TOKEN_EXPIRY_MARGIN_MS)
    ) {
      return stored.accessToken;
    }

    return stored.refreshToken === null ? null : await this.refreshAccessToken(stored.refreshToken);
  }

  private async refreshAccessToken(refreshToken: string): Promise<string | null> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: JUNIE_OAUTH_CLIENT_ID,
    });

    let res: Response;
    try {
      res = await fetchProviderApi(this.fetchApi, JUNIE_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });
    } catch (err) {
      this.logger.debug({ err }, "Junie token refresh failed");
      return null;
    }

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Junie token refresh failed");
      return null;
    }

    try {
      const token = JunieTokenResponseSchema.parse(await res.json());
      const expiresInMs = typeof token.expires_in === "number" ? token.expires_in * 1000 : null;
      this.refreshed = {
        accessToken: token.access_token,
        expiresAtMs:
          expiresInMs === null
            ? null
            : this.now().getTime() + expiresInMs - JUNIE_TOKEN_EXPIRY_MARGIN_MS,
      };
      return token.access_token;
    } catch (err) {
      this.logger.debug({ err }, "Junie token refresh response parse failed");
      return null;
    }
  }

  private async readStoredCredentials(): Promise<JunieStoredCredentials | null> {
    if (!existsSync(this.credentialsPath)) return null;

    try {
      const credentials = JunieCredentialsFileSchema.parse(
        JSON.parse(await fs.readFile(this.credentialsPath, "utf8")),
      );
      const stored = credentials.secrets.find((secret) => secret.key === "jb-account-stored");
      if (!stored) return null;

      const account = JunieStoredAccountSchema.parse(JSON.parse(stored.secret));
      return {
        simpleToken: account.simpleToken?.trim() || null,
        accessToken: account.jbAccount?.access_token?.trim() || null,
        refreshToken: account.jbAccount?.refresh_token?.trim() || null,
      };
    } catch {
      return null;
    }
  }
}
