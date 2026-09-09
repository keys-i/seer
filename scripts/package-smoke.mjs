import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const imported = await exec(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import assert from "node:assert/strict"; import { readProject, localize, checkTranslation, indianLocales } from "@keys-i/seer"; assert.equal(typeof localize, "function"); assert.equal(indianLocales.length, 22); checkTranslation("Home", "मुखपृष्ठ", "en", "hi"); const project = await readProject({ dir: process.argv[1] }); const pages = Object.keys(project.pages[project.config.defaultLocale]).length; console.log("Seer check: " + project.locales.length + " locales, " + pages + " pages.")',
      resolve(repository, "content"),
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
  assert.equal(checked.stdout, imported.stdout);
  await mkdir(resolve(root, "locales"));
  await mkdir(resolve(root, "source"));
  await writeFile(resolve(root, "locales/config.toml"), `version = 1
default_locale = "en"
[site]
name = "Package smoke"
url = "https://example.test/"
[routing]
strategy = "subdirectory"
[localization]
source_dir = "source"
locales = ["en", "hi"]
`);
  await writeFile(resolve(root, "source/index.html"), "<html><head><title>Home</title></head><body><p>Home</p></body></html>");
  await exec(process.execPath, [npm, "exec", "--offline", "--", "seer", "localize", "--extract"], { cwd: root });
  const catalogPath = resolve(root, "locales/hi.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  for (const message of Object.values(catalog.messages)) {
    assert.ok(["Home", "Languages"].includes(message.source));
    message.translation = message.source === "Home" ? "मुखपृष्ठ" : "भाषाएँ";
  }
  await writeFile(catalogPath, JSON.stringify(catalog));
  await exec(process.execPath, [npm, "exec", "--offline", "--", "seer", "localize"], { cwd: root });
  const html = await readFile(resolve(root, "public/hi/index.html"), "utf8");
  assert.match(html, /<html lang="hi" dir="ltr">/);
  assert.match(html, /<title>मुखपृष्ठ<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/example.test\/hi\/"/);
  console.log("packed imports, installed CLI, catalog extraction and offline localization passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
