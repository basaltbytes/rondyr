import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const budget = 2 * 1024 * 1024;
const redirectFile = ".wrangler/deploy/config.json";
const redirect = JSON.parse(readFileSync(redirectFile, "utf8"));
const configPath = resolve(dirname(redirectFile), redirect.configPath);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const moduleDirectory = dirname(resolve(dirname(configPath), config.main));

const files = readdirSync(moduleDirectory, { recursive: true, withFileTypes: true });
const bytes = files
  .filter((file) => file.isFile() && /\.[cm]?js$/u.test(file.name))
  .reduce((total, file) => total + readFileSync(join(file.parentPath, file.name)).byteLength, 0);

process.stdout.write(`Worker JavaScript: ${bytes} bytes (budget: ${budget}).\n`);
if (bytes === 0 || bytes > budget) process.exitCode = 1;
