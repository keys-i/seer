#!/usr/bin/env node
import {
  mkdir,
  lstat,
  opendir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { readProject, type Project } from "./project.js";
import { robotsTxt, sitemapXml } from "./seo.js";

function outside(root: string, path: string) {
  const value = relative(root, path);
  return isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`);
}

const portableName = (value: string) => value.normalize("NFC").toLowerCase();

async function rejectAliases(target: string, names: string[]) {
  const expected = new Map(names.map((name) => [portableName(name), name]));
  for await (const entry of await opendir(target)) {
    const canonical = expected.get(portableName(entry.name));
    if (!canonical) continue;
    if (!entry.isFile()) {
      throw new Error(`generated output is not a regular file: ${entry.name}`);
    }
    if (entry.name !== canonical) {
      throw new Error(`generated output filename is not canonical: ${entry.name}`);
    }
  }
}

async function safeMkdir(root: string, target: string) {
  if (outside(root, target)) throw new Error("output escaped the project");
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    for await (const entry of await opendir(dirname(current))) {
      if (portableName(entry.name) === portableName(part) && entry.name !== part) {
        throw new Error(`output path is not canonical: ${current}`);
      }
    }
    try {
      const status = await lstat(current);
      const canonical = await realpath(current);
      if (canonical.normalize("NFC") !== current.normalize("NFC")) {
        throw new Error(`output path is not canonical: ${current}`);
      }
      if (!status.isDirectory()) {
        throw new Error(`output path is not a real directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o755 });
    }
  }
}

async function atomicWrite(path: string, value: string) {
  const temporary = resolve(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, value, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function compile(project: Project) {
  const content: Array<readonly [string, string]> = [];
  for (const locale of project.locales) {
    const value = `${JSON.stringify(project.content[locale])}\n`;
    content.push([`${locale}.json`, value]);
  }
  return { content, robots: robotsTxt(project), sitemap: sitemapXml(project) };
}

async function writeContent(
  files: Array<readonly [string, string]>,
  target: string,
) {
  const names = files.map(([name]) => name);
  const expected = new Set(names.map(portableName));
  for await (const entry of await opendir(target)) {
    if (!portableName(entry.name).endsWith(".json")) continue;
    if (!entry.isFile()) {
      throw new Error(`generated content contains a non-file: ${entry.name}`);
    }
  }
  await rejectAliases(target, names);
  for (const [name, content] of files) {
    await atomicWrite(resolve(target, name), content);
  }
  for await (const entry of await opendir(target)) {
    const name = portableName(entry.name);
    if (name.endsWith(".json") && !expected.has(name)) {
      await rm(resolve(target, entry.name));
    }
  }
}

async function build(
  project: Project,
  output: ReturnType<typeof compile>,
) {
  const dataDir = resolve(project.root, ".seer/content");
  const publicDir = resolve(project.root, project.config.output.publicDir);
  await safeMkdir(project.root, dataDir);
  await safeMkdir(project.root, publicDir);
  await rejectAliases(publicDir, ["robots.txt", "sitemap.xml"]);
  await writeContent(output.content, dataDir);
  await atomicWrite(resolve(publicDir, "robots.txt"), output.robots);
  await atomicWrite(resolve(publicDir, "sitemap.xml"), output.sitemap);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: { dir: { type: "string", default: "content" } },
  });
  const command = positionals[0];
  if (
    (command !== "check" && command !== "build") ||
    positionals.length !== 1
  ) {
    throw new Error("usage: seer <check|build> [--dir content]");
  }

  const project = await readProject({ dir: values.dir });
  const output = compile(project);
  if (command === "build") await build(project, output);
  const pages = Object.keys(
    project.pages[project.config.defaultLocale] ?? {},
  ).length;
  console.log(`Seer ${command}: ${project.locales.length} locales, ${pages} pages.`);
}

main().catch((error: unknown) => {
  const message = String(error instanceof Error ? error.message : error)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ");
  console.error(`seer: ${message}`);
  process.exitCode = 1;
});
