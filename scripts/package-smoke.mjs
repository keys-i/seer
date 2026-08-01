import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(resolve(tmpdir(), "seer-package-"));
const npm = process.env.npm_execpath;
const cache = process.env.SEER_NPM_CACHE ?? resolve(tmpdir(), "seer-package-cache");
if (!npm) throw new Error("npm_execpath is required");

try {
  const { stdout, stderr } = await exec(
    process.execPath,
    [
      npm,
      "pack",
      "--json",
      "--ignore-scripts",
      "--cache",
      cache,
      "--pack-destination",
      root,
    ],
    { cwd: repository },
  );
  assert.doesNotMatch(stderr, /auto-corrected/);
  const packed = JSON.parse(stdout);
  const { filename } = Array.isArray(packed)
    ? packed[0]
    : Object.values(packed)[0];
  const archive = resolve(root, filename);
  await writeFile(resolve(root, "package.json"), '{"private":true,"type":"module"}\n');
  await exec(
    process.execPath,
    [
      npm,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      cache,
      archive,
    ],
    { cwd: root },
  );
  await exec(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { readProject } from "@keys-i/seer"; if (typeof readProject !== "function") process.exit(1)',
    ],
    { cwd: root },
  );
  const checked = await exec(
    process.execPath,
    [
      npm,
      "exec",
      "--offline",
      "--",
      "seer",
      "check",
      "--dir",
      resolve(repository, "content"),
    ],
    { cwd: root },
  );
  assert.match(checked.stdout, /Seer check: 2 locales, 2 pages/);
  console.log("packed import and installed CLI passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
