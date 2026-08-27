import { afterEach, expect, test } from "vitest";
import { resolveAppVersion } from "./app-version.js";

const previousPrivateBuildVersion = process.env.EXPO_PUBLIC_PASEO_APP_VERSION;

afterEach(() => {
  if (previousPrivateBuildVersion === undefined) {
    delete process.env.EXPO_PUBLIC_PASEO_APP_VERSION;
  } else {
    process.env.EXPO_PUBLIC_PASEO_APP_VERSION = previousPrivateBuildVersion;
  }
});

test("uses the private web build version when present", () => {
  process.env.EXPO_PUBLIC_PASEO_APP_VERSION = "0.5.2-knaou.1";

  expect(resolveAppVersion()).toBe("0.5.2-knaou.1");
});
