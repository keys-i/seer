import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  headData,
  readProject,
  robotsTxt,
  serializeJsonLd,
  sitemapXml,
  type PageSeo,
  type Project,
} from "../src/index.js";

const readRuns = 200;
const helperRuns = 20_000;
const sample = await readProject();

let started = performance.now();
for (let index = 0; index < readRuns; index += 1) await readProject();
const readMs = performance.now() - started;

started = performance.now();
for (let index = 0; index < helperRuns; index += 1) {
  const head = headData(sample, "en", "home");
  robotsTxt(sample);
  sitemapXml(sample);
  serializeJsonLd(head.jsonLd);
}
const helpersMs = performance.now() - started;

const pages = Object.fromEntries(
  Array.from({ length: 50_000 }, (_, index) => [
    `page${index}`,
    {
      path: `/page-${index}`,
      title: "Page",
      description: "Page",
      noindex: false,
    } satisfies PageSeo,
  ]),
);
const large: Project = {
  ...sample,
  locales: ["en"],
  content: { en: {} },
  pages: { en: pages },
};
started = performance.now();
const sitemap = sitemapXml(large);
const sitemapMs = performance.now() - started;

assert.ok(readMs < 2_000, `200 project reads took ${readMs.toFixed(1)} ms`);
assert.ok(sitemapMs < 2_000, `50k sitemap took ${sitemapMs.toFixed(1)} ms`);
console.log(JSON.stringify({
  readProject: {
    runs: readRuns,
    totalMs: Number(readMs.toFixed(2)),
    meanMs: Number((readMs / readRuns).toFixed(3)),
  },
  seoHelpers: {
    runs: helperRuns,
    totalMs: Number(helpersMs.toFixed(2)),
    meanMicroseconds: Number((helpersMs * 1_000 / helperRuns).toFixed(3)),
  },
  sitemap50k: {
    bytes: Buffer.byteLength(sitemap),
    totalMs: Number(sitemapMs.toFixed(2)),
  },
}));
