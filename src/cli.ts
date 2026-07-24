#!/usr/bin/env node
import {
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { readProject, type Project } from "./project.js";
import { robotsTxt, sitemapXml } from "./seo.js";

function outside(root: string, path: string) {
  const value = relative(root, path);
  return isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`);
}

async function safeMkdir(root: string, target: string) {
  if (outside(root, target)) throw new Error("output escaped the project");
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      const status = await lstat(current);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new Error(`output path is not a real directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o755 });
    }
  }
}

async function atomicWrite(path: string, value: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
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
  let bytes = 0;
  for (const locale of project.locales) {
    const value = `${JSON.stringify(project.content[locale], null, 2)}\n`;
    bytes += Buffer.byteLength(value);
    if (bytes > 50 * 1024 * 1024) {
      throw new Error("generated content exceeds the 50 MiB limit");
    }
    content.push([`${locale}.json`, value]);
  }
  return { content, robots: robotsTxt(project), sitemap: sitemapXml(project) };
}

async function writeContent(
  files: Array<readonly [string, string]>,
  target: string,
) {
  const expected = new Set<string>(files.map(([name]) => name));
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name.endsWith(".json") && entry.isSymbolicLink()) {
      throw new Error(`generated content contains a symlink: ${entry.name}`);
    }
    if (entry.isFile() && entry.name.endsWith(".json") && !expected.has(entry.name)) {
      await rm(resolve(target, entry.name));
    }
  }
  for (const [name, content] of files) {
    await atomicWrite(resolve(target, name), content);
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
  console.error(`seer: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
