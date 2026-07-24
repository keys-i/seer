import assert from "node:assert/strict";
import {
  access,
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  headData,
  readProject,
  robotsTxt,
  serializeJsonLd,
  sitemapXml,
  type JsonObject,
} from "../src/index.js";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "seer-"));
  await cp(resolve(repository, "content"), resolve(root, "content"), {
    recursive: true,
  });
  return root;
}

test("loads, merges, and generates safe localized SEO", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = await readProject({ dir: resolve(root, "content") });
  const data = headData(project, "es", "home");

  assert.equal((project.content.es?.brand as JsonObject).logo, "/logo.svg");
  assert.equal(data.alternates["x-default"], "https://example.com/");
  assert.equal(data.canonical, "https://example.com/es/");
  assert.equal(data.dir, "ltr");
  assert.match(sitemapXml(project), /<loc>https:\/\/example\.com\/es\/<\/loc>/);
  assert.match(robotsTxt(project), /User-agent: GPTBot\nDisallow: \//);
  assert.match(robotsTxt(project), /User-agent: \*\nAllow: \//);
  assert.equal(
    serializeJsonLd({ value: "</script>" }).includes("</script>"),
    false,
  );
});

test("CLI replaces only its generated content", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const cli = resolve(repository, "dist/src/cli.js");
  await writeFile(resolve(root, ".keep"), "untouched");
  await exec(process.execPath, [cli, "build", "--dir", resolve(root, "content")]);
  await writeFile(resolve(root, ".seer/content/stale.json"), "{}");

  await exec(process.execPath, [cli, "build", "--dir", resolve(root, "content")]);

  const content = JSON.parse(
    await readFile(resolve(root, ".seer/content/en.json"), "utf8"),
  );
  assert.equal(content.home.heading, "Content humans and search engines can read");
  assert.match(
    await readFile(resolve(root, "public/robots.txt"), "utf8"),
    /Sitemap: https:\/\/example\.com\/sitemap\.xml/,
  );
  await assert.rejects(access(resolve(root, ".seer/content/stale.json")));
  assert.equal(await readFile(resolve(root, ".keep"), "utf8"), "untouched");
});

test("rejects inconsistent localized page policy", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [locale, noindex] of [["en", false], ["es", true]] as const) {
    const path = resolve(root, `content/${locale}.json`);
    const value = JSON.parse(await readFile(path, "utf8"));
    value.seo.pages.home.noindex = noindex;
    await writeFile(path, JSON.stringify(value));
  }

  await assert.rejects(
    readProject({ dir: resolve(root, "content") }),
    /noindex must match across locales/,
  );
});

test("rejects missing translations", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, "content/es.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  delete value.home.summary;
  await writeFile(path, JSON.stringify(value));

  await assert.rejects(
    readProject({ dir: resolve(root, "content") }),
    /es\.json differs at \$\.home/,
  );
});

test("rejects overlapping and symlinked outputs", async (context) => {
  const root = await fixture();
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = resolve(root, "content/config.toml");
  const config = await readFile(configPath, "utf8");
  await writeFile(
    configPath,
    config.replace('public_dir = "public"', 'public_dir = "content/generated"'),
  );

  await assert.rejects(
    readProject({ dir: resolve(root, "content") }),
    /must not overlap/,
  );

  await writeFile(
    configPath,
    config.replace('public_dir = "public"', 'public_dir = "CONTENT"'),
  );
  await assert.rejects(
    readProject({ dir: resolve(root, "content") }),
    /must not overlap/,
  );

  await writeFile(
    configPath,
    config.replace(
      'url = "https://example.com"',
      'url = "https://user@example.com/?debug=1"',
    ),
  );
  await assert.rejects(
    readProject({ dir: resolve(root, "content") }),
    /must not contain credentials/,
  );

  await writeFile(configPath, config);
  const outside = await mkdtemp(resolve(tmpdir(), "seer-outside-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, resolve(root, "public"));
  const cli = resolve(repository, "dist/src/cli.js");
  await assert.rejects(
    exec(process.execPath, [cli, "build", "--dir", resolve(root, "content")]),
    /not a real directory/,
  );
  await assert.rejects(access(resolve(outside, "robots.txt")));
});
