import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import type { UsageInput } from "../shared/input.js";

const API = "https://daily-cloudcode-pa.googleapis.com/v1internal:";
const REFRESH_MARGIN_MS = 60_000;
const credentialsSchema = z.object({
  auth_method: z.string().optional(),
  token: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().optional(),
    expiry: z.iso.datetime({ offset: true }).optional(),
  }),
});
const refreshedSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().finite().positive(),
});
const tierSchema = z.object({ name: z.string().optional(), id: z.string().optional() });
const assistSchema = z.object({
  cloudaicompanionProject: z.string().optional(),
  paidTier: tierSchema.optional(),
  currentTier: tierSchema.optional(),
});
const bucketSchema = z.object({
  bucketId: z.string().min(1),
  displayName: z.string().optional(),
  window: z.string().optional(),
  remainingFraction: z.number().finite().min(0).max(1).optional(),
  remainingAmount: z.union([z.string(), z.number()]).optional(),
  resetTime: z.iso.datetime({ offset: true }).optional(),
  disabled: z.boolean().optional(),
});
const quotaSchema = z.object({
  groups: z
    .array(
      z.object({
        displayName: z.string().optional(),
        buckets: z.array(bucketSchema).default([]),
      }),
    )
    .default([]),
  buckets: z.array(bucketSchema).default([]),
});

interface Ports {
  env: NodeJS.ProcessEnv;
  read: (path: string) => Promise<string>;
  fetch: typeof fetch;
  now: () => number;
  home: () => string;
}
interface CachedToken {
  access: string;
  expiresAt: number;
}

class Rejected extends Error {
  constructor(readonly status: number) {
    super("Antigravity authentication rejected");
  }
}

export class AntigravityUsage {
  private readonly ports: Ports;
  private readonly tokens = new Map<string, CachedToken>();
  private readonly refreshing = new Map<string, Promise<CachedToken>>();

  constructor(ports: Partial<Ports> = {}) {
    this.ports = {
      env: process.env,
      read: (path) => readFile(path, "utf8"),
      fetch,
      now: Date.now,
      home: homedir,
      ...ports,
    };
  }

  private async credentials(path: string) {
    try {
      return credentialsSchema.parse(JSON.parse(await this.ports.read(path)));
    } catch {
      return null;
    }
  }

  async discover(home = this.ports.home()): Promise<UsageAccount[]> {
    const path = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    if (!(await this.credentials(path))) return [];
    return [{ key: hashAccountKey(path), harness: "Antigravity", input: { path } }];
  }

  private async refresh(refreshToken: string): Promise<CachedToken> {
    const clientId = this.ports.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim();
    const clientSecret = this.ports.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      throw new Error(
        "Set ANTIGRAVITY_OAUTH_CLIENT_ID and ANTIGRAVITY_OAUTH_CLIENT_SECRET in the Paseo daemon environment to refresh Antigravity authentication, or run agy to renew the login.",
      );
    }
    const response = await this.ports.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    if ([400, 401, 403].includes(response.status)) throw new Rejected(response.status);
    if (!response.ok) throw new Error(`Antigravity token API returned ${response.status}`);
    const token = refreshedSchema.parse(await response.json());
    return { access: token.access_token, expiresAt: this.ports.now() + token.expires_in * 1000 };
  }

  private async access(
    credentials: z.infer<typeof credentialsSchema>,
  ): Promise<string | UsageReport> {
    const token = credentials.token;
    const expiry = token.expiry ? Date.parse(token.expiry) : Infinity;
    if (expiry > this.ports.now() + REFRESH_MARGIN_MS) return token.access_token;
    if (
      !token.refresh_token ||
      (credentials.auth_method && credentials.auth_method !== "consumer")
    ) {
      return unavailable({
        kind: "expired",
        expiresAt: new Date(expiry).toISOString(),
        refreshedBy: "agy",
      });
    }
    const key = hashAccountKey(token.refresh_token);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt > this.ports.now() + REFRESH_MARGIN_MS) return cached.access;
    let pending = this.refreshing.get(key);
    if (!pending) {
      pending = this.refresh(token.refresh_token);
      this.refreshing.set(key, pending);
    }
    try {
      const refreshed = await pending;
      this.tokens.set(key, refreshed);
      return refreshed.access;
    } finally {
      this.refreshing.delete(key);
    }
  }

  private async request(method: string, access: string, body: object): Promise<unknown> {
    const response = await this.ports.fetch(API + method, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
        // The service rejects generic HTTP clients even with a valid CLI token.
        "User-Agent": "antigravity/1.3.3",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) throw new Rejected(response.status);
    if (!response.ok) throw new Error(`Antigravity ${method} API returned ${response.status}`);
    return response.json();
  }

  async fetch(input: UsageInput): Promise<UsageReport> {
    const credentials = await this.credentials(input.path);
    if (!credentials)
      throw new Error("Antigravity login store no longer exists. Run agy and sign in.");
    try {
      const access = await this.access(credentials);
      if (typeof access !== "string") return access;
      const assist = assistSchema.parse(
        await this.request("loadCodeAssist", access, {
          metadata: { ideType: "ANTIGRAVITY", ideVersion: "1.3.3", pluginType: "GEMINI" },
        }),
      );
      const quota = quotaSchema.parse(
        await this.request(
          "retrieveUserQuotaSummary",
          access,
          assist.cloudaicompanionProject ? { project: assist.cloudaicompanionProject } : {},
        ),
      );
      const windows: UsageWindow[] = [];
      const seen = new Set<string>();
      const add = (bucket: z.infer<typeof bucketSchema>, group?: string) => {
        if (bucket.disabled || bucket.remainingFraction === undefined || seen.has(bucket.bucketId))
          return;
        seen.add(bucket.bucketId);
        const usedPct = (1 - bucket.remainingFraction) * 100;
        const label = [group, bucket.window || bucket.displayName || bucket.bucketId]
          .filter(Boolean)
          .join(" · ");
        windows.push(
          windowFromUsedPct({
            id: bucket.bucketId,
            label,
            summary: true,
            utilizationPct: usedPct,
            resetsAt: bucket.resetTime,
            tone: toneFromUsedPct(usedPct),
          }),
        );
      };
      for (const group of quota.groups)
        for (const bucket of group.buckets) add(bucket, group.displayName);
      for (const bucket of quota.buckets) add(bucket);
      if (!windows.length)
        return unavailable({ kind: "no_quota", detail: "No Antigravity usage quota reported" });
      return {
        status: "available",
        planLabel: assist.paidTier?.name ?? assist.currentTier?.name,
        windows,
        details: [],
      };
    } catch (error) {
      if (error instanceof Rejected)
        return unavailable({ kind: "rejected", status: error.status, refreshedBy: "agy" });
      throw error;
    }
  }
}
