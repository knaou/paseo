import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { AntigravityUsage } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  const usage = new AntigravityUsage();
  server.registerUsageSource({
    id: "antigravity",
    label: "Antigravity",
    icon: "icon.svg",
    input: inputSchema,
    discover: (scope) => {
      if (scope.kind === "global") return usage.discover();
      if (scope.provider === "antigravity")
        return usage.discover(scope.env.HOME ?? scope.env.USERPROFILE);
      return Promise.resolve([]);
    },
    fetch: (input) => usage.fetch(inputSchema.parse(input)),
  });
  return () => {};
}
