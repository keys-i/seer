import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  headData,
  readProject,
  robotsTxt,
  serializeJsonLd,
  sitemapXml,
} from "../dist/src/index.js";
import { assertDistinctFiles, pageDirectory } from "./path.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "docs");
const project = await readProject({ dir: resolve(root, "content") });
const escape = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

function renderPage(locale, pageId, page, metadata, navigation, home, text) {
  const alternates = project.locales.map((language) => {
    const current = language === locale ? ' aria-current="page"' : "";
    return `<a href="${escape(metadata.alternates[language])}" hreflang="${escape(language)}"${current}>${escape(language.toUpperCase())}</a>`;
  }).join("");
  const links = navigation.map(({ id, label, canonical }) =>
    `<a href="${escape(canonical)}"${id === pageId ? ' aria-current="page"' : ""}>${escape(label)}</a>`,
  ).join("");
  const hreflang = Object.entries(metadata.alternates).map(([language, url]) =>
    `<link rel="alternate" hreflang="${escape(language)}" href="${escape(url)}">`,
  ).join("\n    ");
  const robots = metadata.robots
    ? `    <meta name="robots" content="${metadata.robots}">\n`
    : "";
  return `<!doctype html>
<html lang="${escape(metadata.lang)}" dir="${metadata.dir}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="referrer" content="strict-origin-when-cross-origin">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>${escape(metadata.title)}</title>
    <meta name="description" content="${escape(metadata.description)}">
${robots}    <link rel="canonical" href="${escape(metadata.canonical)}">
    ${hreflang}
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="${escape(metadata.siteName)}">
    <meta property="og:title" content="${escape(metadata.title)}">
    <meta property="og:description" content="${escape(metadata.description)}">
    <meta property="og:url" content="${escape(metadata.canonical)}">
    <meta name="twitter:card" content="summary">
    <script type="application/ld+json">${serializeJsonLd(metadata.jsonLd)}</script>
    <style>
      :root { color-scheme: dark; font: 16px/1.6 system-ui, sans-serif; background: #07110d; color: #dff7e8; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 70% 0, #174f35 0, transparent 35rem), #07110d; }
      header, main, footer { width: min(70rem, calc(100% - 2rem)); margin: auto; }
      header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; padding: 1.25rem 0; }
      nav { display: flex; flex-wrap: wrap; gap: .5rem; }
      a { color: #8ff0b6; text-decoration-thickness: .08em; text-underline-offset: .2em; }
      nav a { padding: .35rem .65rem; border: 1px solid #37684d; border-radius: 999px; text-decoration: none; }
      [aria-current="page"] { color: #07110d; background: #8ff0b6; }
      main { padding: clamp(4rem, 12vw, 9rem) 0; }
      .eyebrow { color: #8ff0b6; letter-spacing: .14em; text-transform: uppercase; font-weight: 700; }
      h1 { max-width: 15ch; margin: .2em 0; font-size: clamp(2.6rem, 8vw, 6.5rem); line-height: .98; letter-spacing: -.05em; }
      .summary { max-width: 48rem; font-size: clamp(1.1rem, 2vw, 1.45rem); color: #b7d5c2; }
      .proof { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 1rem; margin-top: 3rem; padding: 0; list-style: none; }
      .proof li { padding: 1.25rem; border: 1px solid #37684d; border-radius: 1rem; background: #0c1c15cc; }
      .proof strong { display: block; font-size: 1.5rem; }
      footer { padding: 2rem 0; border-top: 1px solid #274936; color: #89aa96; }
    </style>
  </head>
  <body>
    <header>
      <strong>${escape(project.config.site.name)}</strong>
      <nav aria-label="${escape(text.primary_navigation)}">${links}</nav>
      <nav aria-label="${escape(text.language_navigation)}">${alternates}</nav>
    </header>
    <main>
      <p class="eyebrow">${escape(metadata.lang)} · ${escape(page.path)}</p>
      <h1>${escape(pageId === "home" ? home.heading : metadata.title)}</h1>
      <p class="summary">${escape(pageId === "home" ? home.summary : metadata.description)}</p>
      <ul class="proof" role="list">
        <li><strong>${project.locales.length}</strong> ${escape(text.validated_locales)}</li>
        <li><strong>${navigation.length}</strong> ${escape(text.validated_pages)}</li>
        <li><strong>0 KB</strong> ${escape(text.browser_runtime)}</li>
      </ul>
    </main>
    <footer>${escape(text.generated_by)} <a href="https://github.com/keys-i/seer">Seer</a>.</footer>
  </body>
</html>
`;
}

const outputFiles = [
  ".nojekyll",
  "robots.txt",
  "sitemap.xml",
  ...project.locales.map((locale) => `content/${locale}.json`),
];
const robots = robotsTxt(project);
const sitemap = sitemapXml(project);
const demoKeys = [
  "primary_navigation",
  "language_navigation",
  "validated_locales",
  "validated_pages",
  "browser_runtime",
  "generated_by",
];
const plans = project.locales.map((locale) => {
  const content = project.content[locale];
  const navigationContent = content.navigation;
  const home = content.home;
  const text = content.demo;
  if (
    !navigationContent ||
    typeof navigationContent !== "object" ||
    Array.isArray(navigationContent) ||
    Object.values(navigationContent).some(
      (label) => typeof label !== "string" || !label.trim(),
    ) ||
    !home ||
    typeof home !== "object" ||
    Array.isArray(home) ||
    typeof home.heading !== "string" ||
    !home.heading.trim() ||
    typeof home.summary !== "string" ||
    !home.summary.trim() ||
    !text ||
    typeof text !== "object" ||
    Array.isArray(text) ||
    demoKeys.some((key) => typeof text[key] !== "string" || !text[key].trim())
  ) {
    throw new Error(`${locale} demo content is invalid`);
  }
  const metadata = new Map();
  const navigation = Object.entries(navigationContent).map(([id, label]) => {
    const data = headData(project, locale, id);
    metadata.set(id, data);
    return { id, label, canonical: data.canonical };
  });
  const pageEntries = Object.entries(project.pages[locale]);
  if (navigation.length !== pageEntries.length) {
    throw new Error(`${locale} demo navigation must include every page`);
  }
  const pages = pageEntries.map(([pageId, page]) => {
    outputFiles.push(`${page.path.slice(1)}index.html`);
    return {
      directory: pageDirectory(output, page.path),
      html: renderPage(locale, pageId, page, metadata.get(pageId), navigation, home, text),
    };
  });
  return {
    locale,
    content: `${JSON.stringify(content, null, 2)}\n`,
    pages,
  };
});
assertDistinctFiles(outputFiles);
if (!outputFiles.includes("index.html")) {
  throw new Error("demo must include a root page");
}

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "content"), { recursive: true });

for (const { locale, content, pages } of plans) {
  for (const { directory, html } of pages) {
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "index.html"), html);
  }
  await writeFile(resolve(output, `content/${locale}.json`), content);
}

await writeFile(resolve(output, "robots.txt"), robots);
await writeFile(resolve(output, "sitemap.xml"), sitemap);
await writeFile(resolve(output, ".nojekyll"), "");
