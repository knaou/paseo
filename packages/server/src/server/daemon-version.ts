import { PackageVersionResolutionError, resolvePackageVersion } from "./package-version.js";

const PRIVATE_SERVER_PACKAGE_NAME = "@knaou/paseo-server";
const SERVER_PACKAGE_NAMES = ["@getpaseo/server", PRIVATE_SERVER_PACKAGE_NAME] as const;

export class DaemonVersionResolutionError extends PackageVersionResolutionError {}

export function isPrivateNpmDaemonPackage(moduleUrl: string = import.meta.url): boolean {
  try {
    resolvePackageVersion({ moduleUrl, packageName: PRIVATE_SERVER_PACKAGE_NAME });
    return true;
  } catch (error) {
    if (error instanceof PackageVersionResolutionError) {
      return false;
    }
    throw error;
  }
}

export function resolveDaemonVersion(moduleUrl: string = import.meta.url): string {
  for (const packageName of SERVER_PACKAGE_NAMES) {
    try {
      return resolvePackageVersion({ moduleUrl, packageName });
    } catch (error) {
      if (!(error instanceof PackageVersionResolutionError)) {
        throw error;
      }
    }
  }

  throw new DaemonVersionResolutionError({
    moduleUrl,
    packageName: SERVER_PACKAGE_NAMES.join(" or "),
  });
}
