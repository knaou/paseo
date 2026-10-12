import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  hashAccountKey,
  unavailable,
  type UsageAccount,
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import type { Input } from "../shared/input.js";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

// Cloudflare fronts opencode.ai and can reject Node's default User-Agent with a
// 1010 browser-signature ban. The console reaches the same endpoint from a
// browser, so a browser User-Agent is what the gateway expects.
const OPENCODE_GO_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const authSchema = z
  .object({
    "opencode-go": z
      .object({ type: z.literal("api"), key: z.string().min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough();
const windowSchema = z.object({
  status: z.enum(["ok", "rate-limited"]),
  percent: z.number().finite(),
  resetsAt: z.iso.datetime(),
});
const responseSchema = z.object({
  usage: z.object({ rolling: windowSchema, weekly: windowSchema, monthly: windowSchema }),
});

function authPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"),
    "opencode",
    "auth.json",
  );
}

export async function readDefaultKey(path = authPath()): Promise<string | null> {
  try {
    const auth = authSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return auth["opencode-go"]?.key ?? null;
  } catch {
    return null;
  }
}

export async function discover(path = authPath()): Promise<UsageAccount[]> {
  return (await readDefaultKey(path)) ? [{ key: hashAccountKey(path), input: { path } }] : [];
}

function windowTone(
  value: { status: "ok" | "rate-limited"; percent: number },
  usedPct: number,
): UsageWindow["tone"] {
  if (value.status === "rate-limited") return "danger";
  return toneFromUsedPct(usedPct);
}

export async function fetchUsage(
  input: Input,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const apiKey = await readDefaultKey(input.path);
  if (!apiKey) throw new Error("OpenCode Go login store no longer exists");
  const response = await fetchApi(OPENCODE_GO_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": OPENCODE_GO_BROWSER_USER_AGENT,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403)
    return unavailable({ kind: "rejected", status: response.status, refreshedBy: "opencode" });
  if (!response.ok) throw new Error(`OpenCode Go usage API returned ${response.status}`);
  const data = responseSchema.parse(await response.json());
  const windows = (
    [
      // The rolling window's length is not reported, so its percent stands without a name.
      ["rolling", "Rolling", "", data.usage.rolling],
      ["weekly", "Weekly", "wk", data.usage.weekly],
      ["monthly", "Monthly", "mo", data.usage.monthly],
    ] as const
  ).map(([id, label, shortLabel, value]) =>
    windowFromUsedPct({
      id,
      label,
      shortLabel,
      utilizationPct: value.percent,
      resetsAt: value.resetsAt,
      tone: windowTone(value, value.percent),
    }),
  );
  return { status: "available", planLabel: "Go", windows };
}
