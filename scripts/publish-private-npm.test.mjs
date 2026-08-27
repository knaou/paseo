import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublishArgs,
  parseArgs,
  privatePackageName,
  transformPackageManifest,
} from "./publish-private-npm.mjs";

test("maps private package names to the fork scope", () => {
  assert.equal(privatePackageName("@knaou", "server"), "@knaou/paseo-server");
});

test("publishes fork prereleases under the private dist-tag", () => {
  assert.deepEqual(createPublishArgs("/tmp/paseo-cli.tgz"), [
    "publish",
    "/tmp/paseo-cli.tgz",
    "--ignore-scripts",
    "--tag",
    "knaou",
    "--registry",
    "https://npm.pkg.github.com",
  ]);
});

test("rejects malformed private publish arguments", () => {
  assert.throws(() => parseArgs(["--scope", "knaou", "--version", "0.5.2-knaou.1"]));
  assert.throws(() => parseArgs(["--scope", "@another-owner", "--version", "0.5.2-knaou.1"]));
  assert.throws(() => parseArgs(["--scope", "@knaou", "--version", "0.5.2-knaou.01"]));
  assert.throws(() => parseArgs(["--scope", "@knaou", "--version", "not-a-version"]));
});

test("rewrites private package metadata without mutating source metadata", () => {
  const manifest = {
    name: "@getpaseo/server",
    version: "0.5.2",
    repository: {
      type: "git",
      url: "https://github.com/knaou/paseo.git",
    },
    publishConfig: { access: "public" },
    dependencies: {
      "@getpaseo/client": "0.5.2",
      express: "^4.18.2",
    },
    peerDependencies: {
      "@getpaseo/plugin": "0.5.2",
    },
  };

  const transformed = transformPackageManifest({
    manifest,
    packageName: "server",
    scope: "@knaou",
    version: "0.5.2-knaou.1",
  });

  assert.equal(transformed.name, "@knaou/paseo-server");
  assert.equal(transformed.version, "0.5.2-knaou.1");
  assert.equal(transformed.repository, undefined);
  assert.deepEqual(transformed.publishConfig, {
    registry: "https://npm.pkg.github.com",
  });
  assert.equal(
    transformed.dependencies["@getpaseo/client"],
    "npm:@knaou/paseo-client@0.5.2-knaou.1",
  );
  assert.equal(transformed.dependencies.express, "^4.18.2");
  assert.equal(transformed.peerDependencies["@getpaseo/plugin"], "*");
  assert.equal(manifest.name, "@getpaseo/server");
  assert.equal(manifest.publishConfig.access, "public");
});
