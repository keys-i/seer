import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const escape = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const homeKeys = [
  "kicker",
  "heading",
  "summary",
  "claim_note",
  "start_title",
  "start_copy",
  "workflow_title",
  "author_title",
  "author_copy",
  "validate_title",
  "validate_copy",
  "ship_title",
  "ship_copy",
  "api_title",
  "api_copy",
  "proof_title",
  "boundary_title",
  "boundary_copy",
];
const demoKeys = [
  "skip_to_content",
  "primary_navigation",
  "language_navigation",
  "documentation",
  "repository",
  "registry",
  "validated_locales",
  "browser_runtime",
  "generated_locale",
  "robots",
  "sitemap",
  "generated_by",
];
function strings(value, keys, path) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) =>
      typeof value[key] !== "string" || !value[key].trim()
    )
  ) {
    throw new Error(`${path} is invalid`);
  }
  return value;
}

const binaries = manifest.bin && typeof manifest.bin === "object" &&
  !Array.isArray(manifest.bin) ? Object.keys(manifest.bin) : [];
const repository = typeof manifest.repository?.url === "string"
  ? manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, "")
  : "";
if (
  binaries.length !== 1 ||
  !URL.canParse(repository) ||
  new URL(repository).protocol !== "https:"
) {
  throw new Error("package.json is invalid for the demo");
}
const packageInfo = strings({
  name: manifest.name,
  install: `npm install --save-dev ${manifest.name}`,
  build: `npx ${binaries[0]} build`,
  repository,
  registry: `https://www.npmjs.com/package/${manifest.name}`,
}, ["name", "install", "build", "repository", "registry"], "package.json");

function languageName(locale) {
  return new Intl.DisplayNames([locale], {
    type: "language",
    languageDisplay: "standard",
  }).of(locale) ?? locale;
}

function renderPage(locale, metadata, home, text) {
  const languages = project.locales.map((language) => {
    const current = language === locale ? ' aria-current="page"' : "";
    return `<li><a href="${escape(metadata.alternates[language])}" lang="${escape(language)}" hreflang="${escape(language)}"${current}>${escape(languageName(language))}</a></li>`;
  }).join("");
  const hreflang = Object.entries(metadata.alternates).map(([language, url]) =>
    `<link rel="alternate" hreflang="${escape(language)}" href="${escape(url)}">`,
  ).join("\n    ");
  const robots = metadata.robots
    ? `    <meta name="robots" content="${metadata.robots}">\n`
    : "";
  const base = project.config.site.url;
  const stylesheet = new URL("site.css", base).href;
  const localeJson = new URL(`content/${locale}.json`, base).href;
  const robotsUrl = new URL("robots.txt", base).href;
  const sitemapUrl = new URL("sitemap.xml", base).href;
  const api = `import { headData, readProject } from "@keys-i/seer";\n\nconst project = await readProject();\nconst metadata = headData(project, "${locale}", "home");`;

  return `<!doctype html>
<html lang="${escape(metadata.lang)}" dir="${metadata.dir}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="referrer" content="strict-origin-when-cross-origin">
    <meta name="theme-color" content="#f4f0e6">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'">
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
    <meta name="twitter:title" content="${escape(metadata.title)}">
    <meta name="twitter:description" content="${escape(metadata.description)}">
    <script type="application/ld+json">${serializeJsonLd(metadata.jsonLd)}</script>
    <link rel="stylesheet" href="${escape(stylesheet)}">
  </head>
  <body>
    <a class="skip" href="#content">${escape(text.skip_to_content)}</a>
    <header class="site-header">
      <div class="shell header-inner">
        <a class="brand" href="${escape(metadata.canonical)}">Seer</a>
        <nav aria-label="${escape(text.primary_navigation)}">
          <a href="${escape(`${packageInfo.repository}#readme`)}">${escape(text.documentation)}</a>
          <a href="${escape(packageInfo.repository)}">${escape(text.repository)}</a>
          <a href="${escape(packageInfo.registry)}">${escape(text.registry)}</a>
        </nav>
        <details class="languages">
          <summary>${escape(text.language_navigation)}: <span lang="${escape(locale)}">${escape(languageName(locale))}</span></summary>
          <ul>${languages}</ul>
        </details>
      </div>
    </header>
    <main id="content">
      <section class="hero shell" aria-labelledby="hero-title">
        <div>
          <p class="eyebrow"><code>${escape(packageInfo.name)}</code> · ${escape(home.kicker)}</p>
          <h1 id="hero-title">${escape(home.heading)}</h1>
          <p class="lead">${escape(home.summary)}</p>
          <p class="claim-note">${escape(home.claim_note)}</p>
        </div>
        <div class="quickstart" aria-labelledby="start-title">
          <p class="code-label" id="start-title">${escape(home.start_title)}</p>
          <p>${escape(home.start_copy)}</p>
          <pre tabindex="0"><code>${escape(packageInfo.install)}
${escape(packageInfo.build)}</code></pre>
        </div>
      </section>
      <section class="section shell" aria-labelledby="workflow-title">
        <h2 id="workflow-title">${escape(home.workflow_title)}</h2>
        <ol class="steps">
          <li><h3>${escape(home.author_title)}</h3><p>${escape(home.author_copy)}</p></li>
          <li><h3>${escape(home.validate_title)}</h3><p>${escape(home.validate_copy)}</p></li>
          <li><h3>${escape(home.ship_title)}</h3><p>${escape(home.ship_copy)}</p></li>
        </ol>
      </section>
      <section class="section split shell" aria-labelledby="api-title">
        <div>
          <h2 id="api-title">${escape(home.api_title)}</h2>
          <p>${escape(home.api_copy)}</p>
        </div>
        <pre tabindex="0"><code>${escape(api)}</code></pre>
      </section>
      <section class="section shell" aria-labelledby="proof-title">
        <h2 id="proof-title">${escape(home.proof_title)}</h2>
        <dl class="facts">
          <div><dt>${project.locales.length}</dt><dd>${escape(text.validated_locales)}</dd></div>
          <div><dt>0 KB</dt><dd>${escape(text.browser_runtime)}</dd></div>
        </dl>
        <ul class="outputs">
          <li><a href="${escape(localeJson)}">${escape(text.generated_locale)}</a></li>
          <li><a href="${escape(robotsUrl)}">${escape(text.robots)}</a></li>
          <li><a href="${escape(sitemapUrl)}">${escape(text.sitemap)}</a></li>
        </ul>
      </section>
      <aside class="boundary shell" aria-labelledby="boundary-title">
        <h2 id="boundary-title">${escape(home.boundary_title)}</h2>
        <p>${escape(home.boundary_copy)}</p>
      </aside>
    </main>
    <footer class="site-footer">
      <div class="shell">${escape(text.generated_by)} <a href="${escape(packageInfo.repository)}">Seer</a> · MIT</div>
    </footer>
  </body>
</html>
`;
}

const css = `:root {
  color-scheme: light;
  font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f4f0e6;
  color: #191915;
  --ink-muted: #5e5c54;
  --line: #cbc5b7;
  --accent: #146c43;
  --code: #171b18;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 20rem; }
a { color: var(--accent); text-underline-offset: .2em; }
a:hover { text-decoration-thickness: .14em; }
a:focus-visible, summary:focus-visible, pre:focus-visible { outline: .2rem solid #191915; outline-offset: .25rem; }
.shell { width: min(70rem, calc(100% - 2rem)); margin-inline: auto; }
.skip { position: fixed; inset: .75rem auto auto .75rem; z-index: 10; padding: .5rem .75rem; background: #fff; transform: translateY(-200%); }
.skip:focus { transform: none; }
.site-header { border-bottom: 1px solid var(--line); }
.header-inner { min-height: 4.5rem; display: flex; align-items: center; gap: 1.5rem; }
.brand { color: inherit; font: 800 1.15rem/1 ui-monospace, SFMono-Regular, Consolas, monospace; text-decoration: none; }
nav { margin-inline-start: auto; display: flex; flex-wrap: wrap; gap: 1.25rem; }
nav a { color: inherit; }
.languages { position: relative; }
.languages summary { color: var(--accent); cursor: pointer; font-weight: 700; }
.languages ul { position: absolute; z-index: 2; inset: calc(100% + .75rem) 0 auto auto; width: max-content; max-width: min(22rem, calc(100vw - 2rem)); max-height: 22rem; overflow: auto; margin: 0; padding: .5rem 1rem; list-style: none; border: 1px solid var(--line); background: #fffdf7; box-shadow: .25rem .25rem 0 #191915; }
.languages li + li { border-top: 1px solid var(--line); }
.languages a { display: block; padding: .45rem 0; color: inherit; }
[aria-current="page"] { font-weight: 800; text-decoration-thickness: .16em; }
.hero { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(18rem, .6fr); gap: clamp(2rem, 7vw, 7rem); align-items: end; padding-block: clamp(4rem, 10vw, 8rem); }
.eyebrow, .code-label { color: var(--accent); font: 700 .82rem/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: .06em; text-transform: uppercase; }
.eyebrow code { text-transform: none; }
h1, h2, h3, p { margin-block-start: 0; }
h1 { max-width: 13ch; margin-block-end: 1.5rem; font-size: clamp(2.65rem, 7vw, 5rem); line-height: .98; letter-spacing: -.055em; text-wrap: balance; }
h2 { max-width: 22ch; font-size: clamp(1.8rem, 4vw, 3rem); line-height: 1.05; letter-spacing: -.035em; text-wrap: balance; }
:lang(ja) h1, :lang(ja) h2, :lang(ko) h1, :lang(ko) h2, :lang(zh) h1, :lang(zh) h2 { line-height: 1.15; letter-spacing: 0; }
h3 { font-size: 1rem; }
.lead { max-width: 43rem; margin: 0; color: var(--ink-muted); font-size: clamp(1.08rem, 2vw, 1.3rem); }
.claim-note { max-width: 43rem; margin: 1rem 0 0; color: var(--ink-muted); font-size: .85rem; }
.quickstart { border-top: .35rem solid var(--accent); padding-top: 1.25rem; }
.quickstart > p:not(.code-label) { color: var(--ink-muted); }
pre { max-width: 100%; overflow: auto; margin: 0; padding: 1.1rem; border: 1px solid #303730; background: var(--code); color: #f5f1e7; font: .86rem/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; }
.section { border-top: 1px solid var(--line); padding-block: clamp(3rem, 7vw, 5rem); }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; margin: 2.5rem 0 0; padding: 0; list-style: none; counter-reset: step; border-block: 1px solid var(--line); }
.steps li { min-width: 0; padding: 1.5rem; counter-increment: step; }
.steps li + li { border-inline-start: 1px solid var(--line); }
.steps h3::before { content: "0" counter(step) " "; color: var(--accent); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.steps p, .split p, .boundary p { color: var(--ink-muted); }
.split { display: grid; grid-template-columns: minmax(0, .65fr) minmax(0, 1.35fr); gap: clamp(2rem, 7vw, 7rem); align-items: start; }
.facts { display: grid; grid-template-columns: repeat(2, 1fr); margin: 2rem 0; border-block: 1px solid var(--line); }
.facts div { padding: 1.25rem 0; }
.facts div + div { padding-inline-start: 1.25rem; border-inline-start: 1px solid var(--line); }
.facts dt { font: 800 clamp(1.5rem, 4vw, 2.5rem)/1 ui-monospace, SFMono-Regular, Consolas, monospace; }
.facts dd { margin: .5rem 0 0; color: var(--ink-muted); }
.outputs { display: flex; flex-wrap: wrap; gap: .75rem 1.5rem; padding: 0; list-style: none; }
.boundary { margin-block-end: clamp(3rem, 7vw, 6rem); padding: 2rem 0; border-block: .35rem solid #191915; }
.boundary h2 { font-size: 1.4rem; }
.boundary p { max-width: 55rem; margin: 0; }
.site-footer { padding-block: 2rem; border-top: 1px solid var(--line); color: var(--ink-muted); }
@media (max-width: 48rem) {
  .header-inner { align-items: flex-start; flex-wrap: wrap; padding-block: 1rem; }
  nav { width: 100%; margin: 0; }
  .hero, .split { grid-template-columns: 1fr; }
  .steps, .facts { grid-template-columns: 1fr; }
  .steps li + li { border-inline-start: 0; border-top: 1px solid var(--line); }
  .facts div + div { border-inline-start: 0; border-top: 1px solid var(--line); padding-inline-start: 0; }
}
@media (max-width: 28rem) {
  nav { gap: .75rem; }
}
`;

const outputFiles = [
  ".nojekyll",
  "site.css",
  "robots.txt",
  "sitemap.xml",
  ...project.locales.map((locale) => `content/${locale}.json`),
];
const robots = robotsTxt(project);
const sitemap = sitemapXml(project);
const plans = project.locales.map((locale) => {
  const content = project.content[locale];
  const home = strings(content.home, homeKeys, `${locale}.home`);
  const text = strings(content.demo, demoKeys, `${locale}.demo`);
  const pages = project.pages[locale];
  if (Object.keys(pages).length !== 1 || !pages.home) {
    throw new Error(`${locale} demo must contain one home page`);
  }
  outputFiles.push(`${pages.home.path.slice(1)}index.html`);
  const metadata = headData(project, locale, "home");
  return {
    locale,
    content: `${JSON.stringify(content, null, 2)}\n`,
    page: {
      directory: pageDirectory(output, pages.home.path),
      html: renderPage(locale, metadata, home, text),
    },
  };
});
assertDistinctFiles(outputFiles);
if (!outputFiles.includes("index.html")) {
  throw new Error("demo must include a root page");
}

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "content"), { recursive: true });
await writeFile(resolve(output, "site.css"), css);

for (const { locale, content, page } of plans) {
  await mkdir(page.directory, { recursive: true });
  await writeFile(resolve(page.directory, "index.html"), page.html);
  await writeFile(resolve(output, `content/${locale}.json`), content);
}

await writeFile(resolve(output, "robots.txt"), robots);
await writeFile(resolve(output, "sitemap.xml"), sitemap);
await writeFile(resolve(output, ".nojekyll"), "");
