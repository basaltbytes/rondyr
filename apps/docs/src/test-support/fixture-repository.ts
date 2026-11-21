// A small repository in a temporary directory, for tests that resolve links against files.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface FixtureRepository {
  readonly root: URL;
  readonly remove: () => void;
}

/** Writes each file of `files`, a map from repository path to content, into a new directory. */
export function fixtureRepository(files: ReadonlyMap<string, string>): FixtureRepository {
  const directory = mkdtempSync(join(tmpdir(), "rondyr-docs-"));
  for (const [path, content] of files) {
    const file = join(directory, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return {
    root: pathToFileURL(`${directory}/`),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}
