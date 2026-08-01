import assert from "node:assert/strict";
import { resolve, win32 } from "node:path";
import test from "node:test";
import { assertDistinctFiles, pageDirectory } from "../demo/path.mjs";

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
