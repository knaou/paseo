import type { UsageInput } from "../shared/input.js";
import { z } from "zod";
import {
  toneFromUsedPct,
  unavailable,
  usedPctOf,
  windowFromUsedPct,
  type UsageAccount,
  type UsageBalance,
  type UsageDetail,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const ApiNumberSchema = z.coerce.number().finite();
const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

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

type QuotaOutcome = { ok: true; quota: ZaiQuotaResponse } | { ok: false; report: UsageReport };

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function limitType(limit: ZaiQuotaLimit): string | undefined {
  return limit.type ?? limit.name;
}

function resetAt(limit: ZaiQuotaLimit): string | null {
  if (limit.nextResetTime === undefined) return null;
  const date = new Date(limit.nextResetTime);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function creditWindowIdentity(limit: ZaiQuotaLimit): { id: string; label: string } | null {
  if (limit.unit === 3) return { id: "session", label: "Session" };
  if (limit.unit === 6) return { id: "weekly", label: "Weekly" };
  return null;
}

function creditWindows(limits: ZaiQuotaLimit[]): UsageWindow[] {
  const windows: UsageWindow[] = [];
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

function webSearchBalance(limits: ZaiQuotaLimit[]): UsageBalance | null {
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

function subscriptionDetails(subscription: ZaiSubscription | undefined): UsageDetail[] {
  if (!subscription) return [];

  const details: UsageDetail[] = [];
  if (subscription.status) {
    details.push({ id: "status", label: "Status", value: subscription.status });
  }
  if (subscription.valid) details.push({ id: "valid", label: "Valid", value: subscription.valid });
  if (subscription.purchaseTime) {
    details.push({ id: "purchase_time", label: "Purchased", value: subscription.purchaseTime });
  }
  return details;
}

/**
 * The quota endpoint is the primary usage signal; without it there is nothing
 * meaningful to report even when the subscription endpoint still answers.
 */
async function readQuota(result: PromiseSettledResult<Response>): Promise<QuotaOutcome> {
  if (result.status === "rejected") return quotaUnavailable();
  if (result.value.status === 401 || result.value.status === 403) {
    return { ok: false, report: unavailable({ kind: "rejected", status: result.value.status }) };
  }
  if (!result.value.ok) {
    return {
      ok: false,
      report: unavailable({
        kind: "no_quota",
        detail: `Z.ai quota API returned ${result.value.status}`,
      }),
    };
  }

  try {
    const quota = ZaiQuotaResponseSchema.parse(await result.value.json());
    if (quota.success === false) {
      return {
        ok: false,
        report: unavailable({
          kind: "no_quota",
          detail: quota.msg?.trim() || "No active coding plan",
        }),
      };
    }
    return { ok: true, quota };
  } catch {
    return quotaUnavailable();
  }
}

function quotaUnavailable(): QuotaOutcome {
  return {
    ok: false,
    report: unavailable({ kind: "no_quota", detail: "Z.ai quota is unavailable" }),
  };
}

async function readSubscription(
  result: PromiseSettledResult<Response>,
): Promise<ZaiSubscriptionResponse | null> {
  if (result.status !== "fulfilled" || !result.value.ok) return null;

  try {
    return ZaiSubscriptionResponseSchema.parse(await result.value.json());
  } catch {
    return null;
  }
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const token = process.env[input.locator];
  if (!token) throw new Error("Z.ai login store no longer exists");

  const request = {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  };
  const [quotaResult, subscriptionResult] = await Promise.allSettled([
    fetchApi(ZAI_QUOTA_URL, request),
    fetchApi(ZAI_SUBSCRIPTION_URL, request),
  ]);

  const quotaOutcome = await readQuota(quotaResult);
  if (!quotaOutcome.ok) return quotaOutcome.report;

  const quota = quotaOutcome.quota;
  const subscription = await readSubscription(subscriptionResult);
  const subscriptionEntry = subscription?.data?.[0];
  const limits = quota.data?.limits ?? [];
  const windows = creditWindows(limits);
  const webSearch = webSearchBalance(limits);

  return {
    status: "available",
    planLabel: subscriptionEntry?.productName || quota.data?.level || undefined,
    windows,
    balances: webSearch ? [webSearch] : [],
    details: subscriptionDetails(subscriptionEntry),
  };
}

export async function discover(): Promise<UsageAccount[]> {
  for (const locator of ["ZAI_API_KEY", "GLM_API_KEY"]) {
    if (process.env[locator]) return [{ key: "default", input: { store: "env", locator } }];
  }
  return [];
}
