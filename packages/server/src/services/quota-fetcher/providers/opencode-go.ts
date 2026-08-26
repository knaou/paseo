import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageWindow } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNullableNumberSchema,
  ApiOptionalStringSchema,
  fetchProviderApi,
  toneFromUsedPct,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

// Cloudflare fronts opencode.ai and rejects Node's default User-Agent with a 1010
// browser-signature ban. The console reaches the same endpoint from a browser, so a
// browser User-Agent is what the gateway expects. Codex's fetcher uses the same trick
// for chatgpt.com.
const OPENCODE_GO_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const OpenCodeGoUsageWindowSchema = z.object({
  status: ApiOptionalStringSchema,
  percent: ApiNullableNumberSchema.optional(),
  resetsAt: ApiOptionalStringSchema,
});

const OpenCodeGoUsageResponseSchema = z.object({
  usage: z
    .object({
      rolling: OpenCodeGoUsageWindowSchema.nullish(),
      weekly: OpenCodeGoUsageWindowSchema.nullish(),
      monthly: OpenCodeGoUsageWindowSchema.nullish(),
    })
    .optional(),
});

type OpenCodeGoUsageWindow = z.infer<typeof OpenCodeGoUsageWindowSchema>;
type OpenCodeGoUsageResponse = z.infer<typeof OpenCodeGoUsageResponseSchema>;

const OpenCodeAuthFileSchema = z.record(
  z.string(),
  z
    .object({
      type: z.string().optional(),
      key: z.string().optional(),
    })
    .passthrough(),
);

interface OpenCodeGoQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
}

function resolveAuthPath(env: NodeJS.ProcessEnv): string {
  const explicit = env["OPENCODE_GO_AUTH_FILE"]?.trim();
  if (explicit) return explicit;
  const dataDir = env["XDG_DATA_HOME"]?.trim() || join(homedir(), ".local", "share");
  return join(dataDir, "opencode", "auth.json");
}

function windowTone(window: OpenCodeGoUsageWindow, usedPct: number | null) {
  if (window.status === "rate-limited") return "danger" as const;
  return toneFromUsedPct(usedPct);
}

function toWindow(
  id: string,
  label: string,
  window: OpenCodeGoUsageWindow | null | undefined,
): ProviderUsageWindow | null {
  if (!window) return null;
  const usedPct = typeof window.percent === "number" ? window.percent : null;
  return windowFromUsedPct({
    id,
    label,
    utilizationPct: usedPct,
    resetsAt: window.resetsAt ?? null,
    tone: windowTone(window, usedPct),
  });
}

export class OpenCodeGoQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "opencode-go";
  readonly displayName = "OpenCode Go";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly credentialsPath: string;

  constructor(options: OpenCodeGoQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
    this.credentialsPath = options.credentialsPath ?? resolveAuthPath(this.env);
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const apiKey = this.env["OPENCODE_GO_API_KEY"]?.trim() || (await this.readApiKey());
    if (!apiKey) return unavailableUsage(this);

    let res: Response;
    try {
      res = await fetchProviderApi(this.fetchApi, OPENCODE_GO_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "User-Agent": OPENCODE_GO_BROWSER_USER_AGENT,
        },
      });
    } catch (err) {
      this.logger.debug({ err }, "OpenCode Go usage fetch failed");
      return unavailableUsage(this);
    }

    // 401 = missing/invalid key; 403 = no Go subscription (or a Cloudflare block).
    // Read-only on credentials either way: leave refresh to the OpenCode CLI.
    if (res.status === 401 || res.status === 403) {
      this.logger.debug({ status: res.status }, "OpenCode Go usage fetch unauthorized");
      return unavailableUsage(this);
    }
    if (!res.ok) {
      this.logger.debug({ status: res.status }, "OpenCode Go usage fetch failed");
      return unavailableUsage(this);
    }

    let parsed: OpenCodeGoUsageResponse;
    try {
      parsed = OpenCodeGoUsageResponseSchema.parse(await res.json());
    } catch (err) {
      this.logger.debug({ err }, "OpenCode Go usage response could not be parsed");
      return unavailableUsage(this);
    }

    const usage = parsed.usage;
    const windows: ProviderUsageWindow[] = [];
    if (usage) {
      const session = toWindow("session", "Session", usage.rolling);
      if (session) windows.push(session);
      const weekly = toWindow("weekly", "Weekly", usage.weekly);
      if (weekly) windows.push(weekly);
      const monthly = toWindow("monthly", "Monthly", usage.monthly);
      if (monthly) windows.push(monthly);
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows,
      balances: [],
      details: [],
      error: null,
    };
  }

  private async readApiKey(): Promise<string | null> {
    if (!existsSync(this.credentialsPath)) return null;
    try {
      const auth = OpenCodeAuthFileSchema.parse(
        JSON.parse(await fs.readFile(this.credentialsPath, "utf8")),
      );
      const entry = auth["opencode-go"];
      return entry?.key?.trim() || null;
    } catch {
      return null;
    }
  }
}
