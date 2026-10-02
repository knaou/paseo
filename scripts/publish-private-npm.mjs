import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_SCOPE = "@getpaseo";
const FORK_NPM_SCOPE = "@knaou";
const GITHUB_PACKAGES_REGISTRY = "https://npm.pkg.github.com";
const PRIVATE_DIST_TAG = "knaou";
const PRIVATE_PACKAGE_SUFFIX = "paseo";
const PACKAGE_ORDER = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"];
const PACKAGE_SET = new Set(PACKAGE_ORDER);
const SEMVER_IDENTIFIER_PATTERN = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER_PATTERN = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${SEMVER_IDENTIFIER_PATTERN}(?:\\.${SEMVER_IDENTIFIER_PATTERN})*)?$`,
);
const SCOPE_PATTERN = /^@[a-z0-9][a-z0-9-]*$/;

function usageAndExit(code = 1) {
  process.stderr.write(
    "Usage: node scripts/publish-private-npm.mjs --scope @owner --version X.Y.Z-owner.N [--dry-run]\n",
  );
  process.exit(code);
}

export function parseArgs(argv) {
  const args = {
    dryRun: false,
    scope: "",
    version: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scope") {
      args.scope = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--version") {
      args.version = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!SCOPE_PATTERN.test(args.scope)) {
    throw new Error(
      `Invalid private npm scope "${args.scope}". Expected a lowercase scope like @knaou.`,
    );
  }
  if (args.scope !== FORK_NPM_SCOPE) {
    throw new Error(`This fork publishes only to ${FORK_NPM_SCOPE}; received ${args.scope}.`);
  }
  if (!SEMVER_PATTERN.test(args.version)) {
    throw new Error(
      `Invalid package version "${args.version}". Expected semver like 0.5.2-knaou.1.`,
    );
  }

  return args;
}

export function sourcePackageName(packageName) {
  assertPackageName(packageName);
  return `${SOURCE_SCOPE}/${packageName}`;
}

export function privatePackageName(scope, packageName) {
  assertPackageName(packageName);
  return `${scope}/${PRIVATE_PACKAGE_SUFFIX}-${packageName}`;
}

function assertPackageName(packageName) {
  if (!PACKAGE_SET.has(packageName)) {
    throw new Error(`Unknown Paseo package: ${packageName}`);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function rewriteInternalDependencies(dependencies, scope, version, peerDependencies = false) {
  if (!dependencies || typeof dependencies !== "object") return dependencies;

  const rewritten = { ...dependencies };
  for (const name of Object.keys(rewritten)) {
    if (!name.startsWith(`${SOURCE_SCOPE}/`)) continue;
    const packageName = name.slice(`${SOURCE_SCOPE}/`.length);
    if (!PACKAGE_SET.has(packageName)) continue;

    // npm aliases in peerDependencies are not consistently resolved across npm
    // versions. The private release always installs this complete package set.
    rewritten[name] = peerDependencies
      ? "*"
      : `npm:${privatePackageName(scope, packageName)}@${version}`;
  }
  return rewritten;
}

export function transformPackageManifest({ manifest, packageName, scope, version }) {
  const transformed = cloneJson(manifest);

  transformed.name = privatePackageName(scope, packageName);
  transformed.version = version;
  // A package linked to this public fork would inherit its readers as package readers.
  delete transformed.repository;
  transformed.publishConfig = {
    ...transformed.publishConfig,
    registry: GITHUB_PACKAGES_REGISTRY,
  };
  delete transformed.publishConfig.access;

  transformed.dependencies = rewriteInternalDependencies(transformed.dependencies, scope, version);
  transformed.optionalDependencies = rewriteInternalDependencies(
    transformed.optionalDependencies,
    scope,
    version,
  );
  transformed.devDependencies = rewriteInternalDependencies(
    transformed.devDependencies,
    scope,
    version,
  );
  transformed.peerDependencies = rewriteInternalDependencies(
    transformed.peerDependencies,
    scope,
    version,
    true,
  );

  return transformed;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status ?? "unknown"}.`);
  }
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function createNpmEnv(tempDir, scope, requireToken) {
  const token = process.env.NODE_AUTH_TOKEN?.trim() ?? "";
  if (requireToken && !token) {
    throw new Error("NODE_AUTH_TOKEN is required. Use a GitHub classic PAT with write:packages.");
  }

  const npmrcPath = path.join(tempDir, ".npmrc");
  const tokenConfig = token ? `//npm.pkg.github.com/:_authToken=${token}\n` : "";
  writeFileSync(npmrcPath, `${scope}:registry=${GITHUB_PACKAGES_REGISTRY}\n${tokenConfig}`, {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    ...process.env,
    NPM_CONFIG_USERCONFIG: npmrcPath,
  };
}

function packSourcePackage(packageName, tempDir, env) {
  const destination = path.join(tempDir, "source", packageName);
  mkdirSync(destination, { recursive: true });
  run(
    "npm",
    [
      "pack",
      "--ignore-scripts",
      `--workspace=${sourcePackageName(packageName)}`,
      "--pack-destination",
      destination,
    ],
    { env },
  );

  const archives = readdirSync(destination).filter((entry) => entry.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`Expected one ${packageName} tarball, found ${archives.length}.`);
  }
  return path.join(destination, archives[0]);
}

function transformTarball({ archivePath, packageName, scope, version, tempDir }) {
  const extractionDir = path.join(tempDir, "extract", packageName);
  mkdirSync(extractionDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", extractionDir]);

  const packageDir = path.join(extractionDir, "package");
  const packageJsonPath = path.join(packageDir, "package.json");
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const transformed = transformPackageManifest({
    manifest,
    packageName,
    scope,
    version,
  });
  writeFileSync(packageJsonPath, `${JSON.stringify(transformed, null, 2)}\n`);

  const destinationDir = path.join(tempDir, "private");
  mkdirSync(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, `${packageName}.tgz`);
  run("tar", ["-czf", destination, "-C", extractionDir, "package"]);
  return destination;
}

function assertTarballContains(archivePath, entryPath) {
  const result = runCapture("tar", ["-tzf", archivePath]);
  if (result.status !== 0) {
    throw new Error(`Unable to inspect ${archivePath}: ${(result.stderr ?? "").trim()}`);
  }
  const entries = result.stdout.split("\n");
  if (!entries.includes(entryPath)) {
    throw new Error(`${archivePath} does not contain ${entryPath}.`);
  }
}

function assertPackageVersionIsAvailable({ packageName, version, env }) {
  const result = runCapture(
    "npm",
    [
      "view",
      `${packageName}@${version}`,
      "version",
      "--json",
      "--registry",
      GITHUB_PACKAGES_REGISTRY,
    ],
    { env },
  );
  if (result.status === 0) {
    throw new Error(`${packageName}@${version} already exists. Publish a new immutable VERSION.`);
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!/\bE404\b|\b404\b|not found/i.test(output)) {
    throw new Error(`Unable to check ${packageName}@${version}: ${output.trim()}`);
  }
}

export function createPublishArgs(archivePath) {
  return [
    "publish",
    archivePath,
    "--ignore-scripts",
    "--tag",
    PRIVATE_DIST_TAG,
    "--registry",
    GITHUB_PACKAGES_REGISTRY,
  ];
}

function publishTarball(archivePath, env) {
  run("npm", createPublishArgs(archivePath), { env });
}

function npmGlobalRoot(prefix, env) {
  const result = runCapture("npm", ["root", "--global", "--prefix", prefix], { env });
  if (result.status !== 0) {
    throw new Error(`Unable to determine npm global root: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout.trim();
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to reserve a local TCP port.");
  }
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return address.port;
}

async function waitForHttpOk(url) {
  const deadline = Date.now() + 30_000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError || "no response"}`);
}

async function verifyPublishedInstall({ scope, version, tempDir, env }) {
  const prefix = path.join(tempDir, "verify-install");
  const cliAlias = `${SOURCE_SCOPE}/cli@npm:${privatePackageName(scope, "cli")}@${version}`;
  run("npm", ["install", "--global", "--prefix", prefix, "--legacy-peer-deps", cliAlias], { env });

  const globalRoot = npmGlobalRoot(prefix, env);
  const cliPath = path.join(globalRoot, SOURCE_SCOPE, "cli", "bin", "paseo");
  run(process.execPath, [cliPath, "--version"], { env });

  const home = path.join(tempDir, "verify-home");
  const port = await reservePort();
  let started = false;
  let verificationError = null;
  try {
    for (const [key, value] of Object.entries({
      "daemon.listen": `127.0.0.1:${port}`,
      "daemon.relay.enabled": false,
      "daemon.mcp.enabled": false,
      "daemon.mcp.injectIntoAgents": false,
      "features.webUi.enabled": true,
    })) {
      run(
        process.execPath,
        [cliPath, "daemon", "config", "set", key, JSON.stringify(value), "--home", home],
        { env },
      );
    }
    run(process.execPath, [cliPath, "daemon", "start", "--home", home], { env });
    started = true;
    await waitForHttpOk(`http://127.0.0.1:${port}/api/health`);
    await waitForHttpOk(`http://127.0.0.1:${port}/`);
  } catch (error) {
    verificationError = error;
  }

  let stopError = null;
  if (started) {
    const result = spawnSync(
      process.execPath,
      [cliPath, "daemon", "stop", "--home", home, "--force"],
      { cwd: REPO_ROOT, env, stdio: "inherit" },
    );
    if (result.error) {
      stopError = result.error;
    } else if (result.status !== 0) {
      stopError = new Error(
        `Unable to stop verification daemon (exit code ${result.status ?? "unknown"}).`,
      );
    }
  }

  if (verificationError && stopError) {
    throw new AggregateError(
      [verificationError, stopError],
      "Published install verification failed.",
    );
  }
  if (verificationError) {
    throw verificationError;
  }
  if (stopError) {
    throw stopError;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-private-npm-"));

  try {
    const env = {
      ...createNpmEnv(tempDir, args.scope, !args.dryRun),
      EXPO_PUBLIC_PASEO_APP_VERSION: args.version,
      NPM_CONFIG_IGNORE_SCRIPTS: "false",
    };
    console.log(`Building private npm packages for ${args.scope} at ${args.version}`);
    run("npm", ["run", "lint"], { env });
    run("npm", ["run", "build:server:clean"], { env });
    run("npm", ["run", "build:daemon-web-ui"], { env });
    run("npm", ["run", "typecheck"], { env });

    const archives = new Map();
    for (const packageName of PACKAGE_ORDER) {
      const sourceArchive = packSourcePackage(packageName, tempDir, env);
      const privateArchive = transformTarball({
        archivePath: sourceArchive,
        packageName,
        scope: args.scope,
        version: args.version,
        tempDir,
      });
      if (packageName === "server") {
        assertTarballContains(privateArchive, "package/dist/server/web-ui/index.html");
      }
      archives.set(packageName, privateArchive);
    }

    if (args.dryRun) {
      console.log(`Validated ${PACKAGE_ORDER.length} private tarballs.`);
      return;
    }

    for (const packageName of PACKAGE_ORDER) {
      assertPackageVersionIsAvailable({
        packageName: privatePackageName(args.scope, packageName),
        version: args.version,
        env,
      });
    }

    for (const packageName of PACKAGE_ORDER) {
      const archive = archives.get(packageName);
      if (!archive) throw new Error(`Missing transformed ${packageName} archive.`);
      console.log(`Publishing ${privatePackageName(args.scope, packageName)}@${args.version}`);
      publishTarball(archive, env);
    }

    await verifyPublishedInstall({ ...args, tempDir, env });
    console.log(`Published and verified ${privatePackageName(args.scope, "cli")}@${args.version}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
