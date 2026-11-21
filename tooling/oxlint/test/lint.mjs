import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Lints `source` as `filename` under `apps/rondyr/dashboard/src`, in a probe folder next to it that keeps the
 * file's name, and returns the oxlint process result.
 */
export const lint = (filename, source) => {
  const folder = join(
    root,
    "apps/rondyr/dashboard/src",
    dirname(filename),
    `oxlint-probe-${process.pid}`,
  );
  mkdirSync(folder, { recursive: true });
  const probe = join(folder, basename(filename));
  writeFileSync(probe, source);
  try {
    return spawnSync("oxlint", [probe], {
      cwd: root,
      encoding: "utf8",
    });
  } finally {
    rmSync(folder, { recursive: true });
  }
};
