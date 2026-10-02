import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveDaemonRunnerEntryFromServerExport } from "./local-daemon.js";

describe("daemon runner package resolution", () => {
  test.each(["@getpaseo/server", "@knaou/paseo-server"])(
    "resolves the installed runner from %s metadata through an npm alias",
    async (name) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-server-runner-"));
      try {
        const packageRoot = path.join(root, "node_modules", "@getpaseo", "server");
        const runner = path.join(packageRoot, "dist", "scripts", "supervisor-entrypoint.js");
        const serverExport = path.join(packageRoot, "dist", "server", "server", "exports.js");
        await mkdir(path.dirname(runner), { recursive: true });
        await mkdir(path.dirname(serverExport), { recursive: true });
        await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name }));
        await writeFile(runner, "");

        expect(resolveDaemonRunnerEntryFromServerExport(serverExport)).toBe(runner);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
