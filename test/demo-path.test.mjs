import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertDistinctFiles, pageDirectory } from "../demo/path.mjs";
import { headData, readProject } from "../dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const escape = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

test("maps demo routes inside a Windows output directory", () => {
  const nativeOutput = resolve("docs");
  assert.equal(pageDirectory(nativeOutput, "/"), nativeOutput);
  assert.equal(pageDirectory(nativeOutput, "/guide/"), resolve("docs/guide"));
  const output = "C:\\repo\\docs";
  assert.equal(
    pageDirectory(output, "/guide/", win32.resolve),
    "C:\\repo\\docs\\guide",
  );
  for (const path of [
    "/guide",
    "/guide//",
    "/guide//nested/",
    "/C:/outside/",
    "/guide/.GIT/",
    "/git~1/",
    "/café/",
    "/foo%20bar/",
    "/caf%C3%A9/",
  ]) {
    assert.throws(() => pageDirectory(output, path, win32.resolve));
  }
});

test("rejects portable demo file collisions", () => {
  assert.doesNotThrow(() => assertDistinctFiles([
    "index.html",
    "a/index.html",
    "a/nested/index.html",
    "content/en.json",
    "robots.txt",
  ]));
  for (const files of [
    ["robots.txt", "robots.txt/index.html"],
    ["content/en.json", "content/en.json/index.html"],
    ["a/index.html", "a/index.html/index.html"],
    ["a/index.html", "A/index.html"],
    ["Σ/index.html", "ς/index.html"],
    ["ΐ/index.html", "Ϊ́/index.html"],
    ["café/index.html", "café/index.html"],
  ]) {
    assert.throws(() => assertDistinctFiles(files), /demo output collision/);
  }
});

test("renders every demo locale without a browser runtime", async (context) => {
  const project = await readProject({ dir: resolve(root, "content") });
  const locales = project.locales;
  assert.deepEqual(locales, ["en", "es", "ja", "ko", "zh-Hans"]);

  for (const locale of locales) {
    await context.test(locale, async () => {
      const metadata = headData(project, locale, "home");
      const html = await readFile(
        resolve(
          pageDirectory(resolve(root, "docs"), project.pages[locale].home.path),
          "index.html",
        ),
        "utf8",
      );
      assert.ok(html.includes(`<html lang="${locale}" dir="${metadata.dir}">`));
      assert.ok(html.includes("npm install --save-dev @keys-i/seer"));
      assert.ok(html.includes("style-src 'self'"));
      assert.doesNotMatch(html, /unsafe-inline|<style/i);
      assert.deepEqual(
        html.match(/<script\b[^>]*>/gi),
        ['<script type="application/ld+json">'],
      );
      assert.ok(html.includes(
        `<link rel="canonical" href="${escape(metadata.canonical)}">`,
      ));
      for (const [language, url] of Object.entries(metadata.alternates)) {
        assert.ok(html.includes(
          `<link rel="alternate" hreflang="${escape(language)}" href="${escape(url)}">`,
        ));
      }
      assert.ok(html.includes(
        `<meta property="og:title" content="${escape(metadata.title)}">`,
      ));
      assert.ok(html.includes(
        `<meta property="og:description" content="${escape(metadata.description)}">`,
      ));
      assert.ok(html.includes(
        `<meta property="og:url" content="${escape(metadata.canonical)}">`,
      ));
      assert.ok(html.includes(
        `<meta name="twitter:title" content="${escape(metadata.title)}">`,
      ));
      assert.ok(html.includes(
        `<meta name="twitter:description" content="${escape(metadata.description)}">`,
      ));
      const jsonLd = html.match(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
      );
      assert.ok(jsonLd);
      assert.deepEqual(JSON.parse(jsonLd[1]), metadata.jsonLd);
    });
  }

  await assert.rejects(access(resolve(root, "docs/docs/index.html")));
});
