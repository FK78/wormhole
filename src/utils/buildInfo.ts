import { readFileSync } from "node:fs";

const readPackageVersion = (): string => {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };

    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
};

export const buildInfo = {
  version: readPackageVersion(),
  commit: process.env.GIT_COMMIT ?? "unknown",
};
