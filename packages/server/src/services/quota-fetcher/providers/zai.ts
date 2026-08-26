import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  ApiOptionalStringSchema,
  fetchProviderApi,
  toneFromUsedPct,
  toIsoStringOrNull,
  unavailableUsage,
  usedPctOf,
  windowFromUsedPct,
} from "../usage.js";

const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const ZAI_SUBSCRIPTION_URL = "https://api.z.ai/api/biz/subscription/list";

const ZaiSubscriptionResponseSchema = z.object({
  data: z
    .array(
      z.object({
        productName: ApiOptionalStringSchema,
        status: ApiOptionalStringSchema,
        purchaseTime: ApiOptionalStringSchema,
        valid: ApiOptionalStringSchema,
      }),
    )
    .optional(),
});

const ZaiQuotaLimitSchema = z.object({
  type: ApiOptionalStringSchema,
  name: ApiOptionalStringSchema,
  unit: ApiNumberSchema.optional(),
  percentage: ApiNumberSchema.optional(),
  nextResetTime: ApiNumberSchema.optional(),
  usage: ApiNumberSchema.optional(),
  currentValue: ApiNumberSchema.optional(),
  remaining: ApiNumberSchema.optional(),
});

const ZaiQuotaResponseSchema = z.object({
  success: z.boolean().optional(),
  msg: ApiOptionalStringSchema,
  data: z
    .object({
      level: ApiOptionalStringSchema,
      limits: z.array(ZaiQuotaLimitSchema).optional(),
    })
    .optional(),
});

type ZaiQuotaLimit = z.infer<typeof ZaiQuotaLimitSchema>;
type ZaiQuotaResponse = z.infer<typeof ZaiQuotaResponseSchema>;
type ZaiSubscriptionResponse = z.infer<typeof ZaiSubscriptionResponseSchema>;
type ZaiSubscription = NonNullable<ZaiSubscriptionResponse["data"]>[number];

interface ZaiQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function limitType(limit: ZaiQuotaLimit): string | undefined {
  return limit.type ?? limit.name;
}

function resetAt(limit: ZaiQuotaLimit): string | null {
  return limit.nextResetTime === undefined ? null : toIsoStringOrNull(limit.nextResetTime);
}

function creditWindowIdentity(limit: ZaiQuotaLimit): { id: string; label: string } | null {
  if (limit.unit === 3) return { id: "session", label: "Session" };
  if (limit.unit === 6) return { id: "weekly", label: "Weekly" };
  return null;
}

function creditWindows(limits: ZaiQuotaLimit[]): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  const seen = new Set<string>();

  for (const limit of limits) {
    const type = limitType(limit);
    if ((type !== "CREDIT_LIMIT" && type !== "TOKENS_LIMIT") || limit.percentage === undefined) {
      continue;
    }

    const window = creditWindowIdentity(limit);
    if (!window || seen.has(window.id)) continue;
    seen.add(window.id);

    const usedPct = clampPct(limit.percentage);
    windows.push(
      windowFromUsedPct({
        ...window,
        utilizationPct: usedPct,
        resetsAt: resetAt(limit),
        tone: toneFromUsedPct(usedPct),
      }),
    );
  }

  return windows;
}

function webSearchBalance(limits: ZaiQuotaLimit[]): ProviderUsageBalance | null {
  const limit = limits.find((candidate) => limitType(candidate) === "TIME_LIMIT");
  if (!limit) return null;

  const maximum = limit.usage ?? null;
  const remaining = limit.remaining ?? null;
  const used =
    limit.currentValue ??
    (maximum !== null && remaining !== null ? Math.max(0, maximum - remaining) : null);
  if (maximum === null && used === null && remaining === null) return null;

  return {
    id: "web_search",
    label: "Web Search",
    used,
    remaining:
      remaining ?? (maximum !== null && used !== null ? Math.max(0, maximum - used) : null),
    limit: maximum,
    unit: "requests",
    resetsAt: resetAt(limit),
    tone: toneFromUsedPct(usedPctOf(used, maximum)),
  };
}

function subscriptionDetails(subscription: ZaiSubscription | undefined): ProviderUsageDetail[] {
  if (!subscription) return [];

  const details: ProviderUsageDetail[] = [];
  if (subscription.status) {
    details.push({ id: "status", label: "Status", value: subscription.status });
  }
  if (subscription.valid) details.push({ id: "valid", label: "Valid", value: subscription.valid });
  if (subscription.purchaseTime) {
    details.push({ id: "purchase_time", label: "Purchased", value: subscription.purchaseTime });
  }
  return details;
}

export class ZaiQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "zai";
  readonly displayName = "Z.ai";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: ZaiQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token = process.env["ZAI_API_KEY"] || process.env["GLM_API_KEY"];
    if (!token) return unavailableUsage(this);

    const request = {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    };
    const [quotaResult, subscriptionResult] = await Promise.allSettled([
      fetchProviderApi(this.fetchApi, ZAI_QUOTA_URL, request),
      fetchProviderApi(this.fetchApi, ZAI_SUBSCRIPTION_URL, request),
    ]);

    const quota = await this.readQuota(quotaResult);
    if (!quota) return unavailableUsage(this);
    const subscription = await this.readSubscription(subscriptionResult);
    return this.toUsage(quota, subscription?.data?.[0]);
  }

  private async readQuota(
    result: PromiseSettledResult<Response>,
  ): Promise<ZaiQuotaResponse | null> {
    if (result.status === "rejected") {
      this.logger.debug({ err: result.reason }, "Z.ai quota fetch failed");
      return null;
    }

    if (!result.value.ok) {
      this.logger.debug({ status: result.value.status }, "Z.ai quota fetch failed");
      return null;
    }

    const quota = ZaiQuotaResponseSchema.parse(await result.value.json());
    if (quota.success === false) {
      this.logger.debug({ message: quota.msg }, "Z.ai quota request was rejected");
      return null;
    }
    return quota;
  }

  private async readSubscription(
    result: PromiseSettledResult<Response>,
  ): Promise<ZaiSubscriptionResponse | null> {
    if (result.status !== "fulfilled") return null;
    if (!result.value.ok) return null;

    try {
      return ZaiSubscriptionResponseSchema.parse(await result.value.json());
    } catch (err) {
      this.logger.debug({ err }, "Z.ai subscription response could not be parsed");
      return null;
    }
  }

  private toUsage(
    quota: ZaiQuotaResponse,
    subscription: ZaiSubscription | undefined,
  ): ProviderUsage {
    const limits = quota.data?.limits ?? [];
    const windows = creditWindows(limits);
    const webSearch = webSearchBalance(limits);
    const balances = webSearch ? [webSearch] : [];

    if (windows.length === 0 && balances.length === 0) {
      this.logger.warn("Z.ai quota response parsed but produced no limits");
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: subscription?.productName || quota.data?.level || null,
      windows,
      balances,
      details: subscriptionDetails(subscription),
      error: null,
    };
  }
}
