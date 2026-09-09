import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { serialize } from "parse5";
import {
  checkTranslation,
  indianLocales,
  localize,
  pageUrl,
} from "../src/index.js";
import { extractHtml } from "../src/localize.js";
import { parseConfig } from "../src/project.js";
import {
  sarvamLanguage,
  translateMessages,
  type Message,
} from "../src/translate.js";

const configuration = `version = 1
default_locale = "en"
[site]
name = "Notes"
url = "https://example.test/notes/"
[output]
public_dir = "public"
[routing]
strategy = "subdirectory"
[localization]
source_dir = "source"
locales = ["en", "hi"]
exclude = ["/404.html"]
preserve = ["Seer", "C++"]
`;
const source =
  '<!doctype html><html lang="en"><head><title>Course notes</title><meta name="description" content="Study compilers."><link rel="canonical" href="https://example.test/notes/"><script type="application/ld+json">{"@type":"TechArticle","url":"https://example.test/notes/","inLanguage":"en","author":{"@type":"Person","name":"Keys"}}</script></head><body><h1>Course notes</h1><p>Read <code>x &lt; 3</code> carefully.</p><p>Learn Seer</p><a href="guide/#types">Guide</a><img src="assets/logo.svg" alt="Course logo"><span class="arithmatex">\\(x = 3\\)</span><script>window.note = "Do not translate this";</script></body></html>';
const translations: Record<string, string> = {
  "Course notes": "पाठ्यक्रम के नोट्स",
  "Study compilers.": "कंपाइलर का अध्ययन करें।",
  "Read {{SEER_HTML_0}} carefully.": "{{SEER_HTML_0}} को ध्यान से पढ़ें।",
  "Learn {{SEER_TERM_0}}": "{{SEER_TERM_0}} सीखें।",
  Guide: "मार्गदर्शिका",
  "Course logo": "पाठ्यक्रम का लोगो",
  Home: "मुखपृष्ठ",
  Languages: "भाषाएँ",
  Search: "खोजें",
  "{{SEER_TERM_0}} matching documents": "{{SEER_TERM_0}} मेल खाते दस्तावेज़",
};
async function fixture(t: TestContext, strategy = "subdirectory") {
  const root = await mkdtemp(resolve(tmpdir(), "seer-localize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of [
    "locales",
    "source/guide",
    "source/assets",
    "source/search",
  ])
    await mkdir(resolve(root, dir), { recursive: true });
  await writeFile(
    resolve(root, "locales/config.toml"),
    configuration.replace(
      'strategy = "subdirectory"',
      `strategy = "${strategy}"`,
    ),
  );
  const withSchema = source
    .replace(
      'type="application/ld+json">{',
      'type="application/ld+json">{"@graph":[{"headline":"Course notes",',
    )
    .replace('"name":"Keys"}}</script>', '"name":"Keys"}}]}</script>');
  await writeFile(
    resolve(root, "source/index.html"),
    withSchema.replace(
      "</body>",
      '<script id="__config" type="application/json">{"base":".","translations":{"search":"Search","matches":"# matching documents"}}</script></body>',
    ),
  );
  await writeFile(
    resolve(root, "source/guide/index.html"),
    '<html><head><title>Guide</title></head><body><a href="../">Home</a></body></html>',
  );
  await writeFile(resolve(root, "source/404.html"), "Missing page");
  await writeFile(resolve(root, "source/assets/logo.svg"), "<svg/>");
  await writeFile(
    resolve(root, "source/search/search_index.json"),
    JSON.stringify({ config: { lang: ["en"] }, docs: [] }),
  );
  return root;
}
async function fill(root: string) {
  const path = resolve(root, "locales/hi.json");
  const catalog = JSON.parse(await readFile(path, "utf8"));
  for (const message of Object.values(catalog.messages) as Message[]) {
    assert.ok(Object.hasOwn(translations, message.source), message.source);
    message.translation = translations[message.source]!;
  }
  await writeFile(path, JSON.stringify(catalog));
}

test("routes Indian locales in subdirectories or subdomains and preserves script joiners", () => {
  const config = parseConfig(configuration);
  assert.equal(
    pageUrl(config, "en", "/guide/"),
    "https://example.test/notes/en/guide/",
  );
  assert.equal(
    pageUrl(config, "hi", "/पढ़ें/"),
    "https://example.test/notes/hi/%E0%A4%AA%E0%A4%A2%E0%A4%BC%E0%A5%87%E0%A4%82/",
  );
  assert.match(pageUrl(config, "ml", "/അവൻ\u200d/"), /%E2%80%8D/);
  assert.throws(() => pageUrl(config, "hi", "/bad\u202E/"), /safe/);
  config.routing = { strategy: "subdomain" };
  assert.equal(
    pageUrl(config, "hi", "/guide/"),
    "https://hi.example.test/notes/guide/",
  );
  assert.equal(indianLocales.length, 22);
  for (const locale of indianLocales)
    assert.match(sarvamLanguage(locale), /-IN$/);
  assert.equal(sarvamLanguage("or"), "od-IN");
});

test("checks scripts, source copying, placeholders and all supported language directions", () => {
  checkTranslation("Hello {name}", "नमस्ते {name}", "en", "hi");
  checkTranslation("Hello", "ہیلو", "en", "ur");
  checkTranslation("Hello", "নমস্কার", "en", "bn");
  checkTranslation("Hello", "வணக்கம்", "en", "ta");
  assert.throws(
    () => checkTranslation("Hello {name}", "नमस्ते", "en", "hi"),
    /placeholder/,
  );
  assert.throws(
    () => checkTranslation("Hello", "Hello", "en", "hi"),
    /unchanged/,
  );
  assert.throws(
    () => checkTranslation("Hello", "Bonjour", "en", "ta"),
    /script/,
  );
  assert.equal(
    (
      new Intl.Locale("ur") as Intl.Locale & {
        getTextInfo(): { direction: string };
      }
    ).getTextInfo().direction,
    "rtl",
  );
  assert.equal(
    (
      new Intl.Locale("hi") as Intl.Locale & {
        getTextInfo(): { direction: string };
      }
    ).getTextInfo().direction,
    "ltr",
  );
});

test("extracts sentence context while preserving inline code, math, scripts and glossary terms", () => {
  const parsed = extractHtml(source, "en", ["Seer"]);
  assert.ok(
    parsed.units.some(
      (unit) => unit.source === "Read {{SEER_HTML_0}} carefully.",
    ),
  );
  assert.ok(
    parsed.units.some((unit) => unit.source === "Learn {{SEER_TERM_0}}"),
  );
  assert.ok(
    parsed.units.every(
      (unit) =>
        !unit.source.includes("Do not translate") &&
        !unit.source.includes("x = 3"),
    ),
  );
  for (const unit of parsed.units) {
    const translated = translations[unit.source]!;
    assert.ok(translated, unit.source);
    checkTranslation(unit.source, translated, "en", "hi");
    unit.apply(translated);
  }
  const html = serialize(parsed.document);
  assert.match(html, /<code>x &lt; 3<\/code> को ध्यान से पढ़ें/);
  assert.match(html, /Seer सीखें/);
  assert.match(html, /Do not translate this/);
  const dangerous = extractHtml("<p>Hello</p>", "en");
  dangerous.units[0]!.apply('<img src=x onerror="alert(1)">नमस्ते');
  assert.doesNotMatch(serialize(dangerous.document), /<img/);
});

test("builds linked localized HTML, canonical metadata, search files and reusable catalogs", async (t) => {
  const root = await fixture(t);
  const dir = resolve(root, "locales");
  const extracted = await localize({ dir, extract: true });
  assert.equal(extracted.pages, 2);
  assert.ok(extracted.missing[0]!.missing > 0);
  await fill(root);
  await localize({ dir });
  const home = await readFile(resolve(root, "public/hi/index.html"), "utf8");
  assert.match(home, /<html lang="hi" dir="ltr">/);
  assert.match(home, /href="https:\/\/example.test\/notes\/hi\/guide\/#types"/);
  assert.match(home, /src="https:\/\/example.test\/notes\/assets\/logo.svg"/);
  assert.match(
    home,
    /hreflang="x-default" href="https:\/\/example.test\/notes\/en\/"/,
  );
  assert.match(home, /property="og:locale" content="hi_IN"/);
  assert.match(home, /"@type":"TechArticle"/);
  assert.match(home, /"name":"Keys"/);
  assert.match(home, /"inLanguage":"hi"/);
  assert.match(home, /"base":"https:\/\/example.test\/notes\/"/);
  assert.match(home, /"search":"खोजें"/);
  const search = JSON.parse(
    await readFile(resolve(root, "public/search/search_index.json"), "utf8"),
  );
  assert.ok(
    search.docs.some(
      (page: { location: string; title: string }) =>
        page.location.endsWith("/hi/") &&
        page.title === translations["Course notes"],
    ),
  );
  assert.equal((home.match(/rel="canonical"/g) ?? []).length, 1);
  const sitemap = await readFile(resolve(root, "public/sitemap.xml"), "utf8");
  assert.match(sitemap, /\/hi\/guide\//);
  assert.doesNotMatch(sitemap, /404/);
  const cache = await readFile(resolve(dir, "hi.json"), "utf8");
  await localize({ dir });
  assert.equal(await readFile(resolve(dir, "hi.json"), "utf8"), cache);
  assert.equal(
    await readFile(resolve(root, "public/hi/index.html"), "utf8"),
    home,
  );
});

test("source edits invalidate translations without overwriting the published site", async (t) => {
  const root = await fixture(t);
  const dir = resolve(root, "locales");
  await localize({ dir, extract: true });
  await fill(root);
  await localize({ dir });
  const previous = await readFile(
    resolve(root, "public/hi/index.html"),
    "utf8",
  );
  await writeFile(
    resolve(root, "source/index.html"),
    source.replace("Study compilers.", "Study parsing."),
  );
  await assert.rejects(localize({ dir }), /translations needed/);
  assert.equal(
    await readFile(resolve(root, "public/hi/index.html"), "utf8"),
    previous,
  );
});

test("subdomain builds create per-host sitemaps and reciprocal language links", async (t) => {
  const root = await fixture(t, "subdomain");
  const dir = resolve(root, "locales");
  await localize({ dir, extract: true });
  await fill(root);
  await localize({ dir });
  const home = await readFile(resolve(root, "public/hi/index.html"), "utf8");
  assert.match(home, /https:\/\/hi.example.test\/notes\/guide/);
  const sitemap = await readFile(
    resolve(root, "public/hi/sitemap.xml"),
    "utf8",
  );
  assert.match(sitemap, /https:\/\/hi.example.test/);
  assert.doesNotMatch(sitemap, /https:\/\/en.example.test/);
  assert.match(
    await readFile(resolve(root, "public/sitemap.xml"), "utf8"),
    /<sitemapindex/,
  );
  assert.match(
    await readFile(resolve(root, "public/hi/robots.txt"), "utf8"),
    /Sitemap: https:\/\/hi.example.test\/notes\/sitemap.xml/,
  );
});

test("translation batches validate provider results and reuse cached entries", async () => {
  const messages: Record<string, Message> = {
    heading: { source: "Course notes", context: "h1" },
    home: { source: "Home", context: "a" },
  };
  let requests = 0;
  let saves = 0;
  const fakeFetch: typeof fetch = async (url, options) => {
    assert.equal(url, "https://api.sarvam.ai/translate");
    const body = JSON.parse(String(options?.body));
    assert.equal(body.target_language_code, "hi-IN");
    assert.equal(body.model, "sarvam-translate:v1");
    assert.ok(body.input.length <= 2_000);
    requests += 1;
    return new Response(
      JSON.stringify({
        request_id: "fixture-request",
        translated_text: body.input
          .replace("Course notes", translations["Course notes"])
          .replace("Home", translations.Home),
      }),
    );
  };
  const options = {
    key: "test-only-key",
    fetch: fakeFetch,
    save: async () => {
      saves += 1;
    },
  };
  await translateMessages(messages, "en", "hi", options);
  assert.equal(requests, 1);
  assert.equal(saves, 1);
  assert.equal(messages.heading?.translation, translations["Course notes"]);
  await translateMessages(messages, "en", "hi", options);
  assert.equal(requests, 1);
  assert.equal(messages.home?.requestId, "fixture-request");
  await assert.rejects(
    translateMessages({ home: { source: "Home", context: "a" } }, "en", "hi", {
      ...options,
      fetch: async () => new Response("{}", { status: 429 }),
    }),
    /HTTP 429/,
  );
});

test("rejects overlapping directories and symlinked input", async (t) => {
  const root = await fixture(t);
  const dir = resolve(root, "locales");
  await symlink(
    resolve(root, "locales/config.toml"),
    resolve(root, "source/alias.html"),
  );
  await assert.rejects(localize({ dir, extract: true }), /symlink|non-regular/);
  await rm(resolve(root, "source/alias.html"));
  await writeFile(
    resolve(dir, "config.toml"),
    configuration.replace(
      'public_dir = "public"',
      'public_dir = "source/nested"',
    ),
  );
  await assert.rejects(localize({ dir }), /overlap/);
});

test("rejects changed provider separators and keeps failed batches out of the catalog", async () => {
  const messages: Record<string, Message> = {
    home: { source: "Home", context: "a" },
  };
  await assert.rejects(
    translateMessages(messages, "en", "hi", {
      key: "test-only-key",
      fetch: async () =>
        new Response(
          JSON.stringify({
            request_id: "bad-separator",
            translated_text: "मुखपृष्ठ",
          }),
        ),
      save: async () => assert.fail("invalid results must not be saved"),
    }),
    /separators/,
  );
  assert.equal(messages.home?.translation, undefined);
  await assert.rejects(localize({ extract: true, translate: true }), /either/);
});

test("chunks long sentences within the provider limit without splitting placeholders", async () => {
  const source =
    "Start here. " +
    "Read these notes carefully ".repeat(100) +
    "{{name}}. " +
    "Study carefully. ".repeat(150);
  const messages: Record<string, Message> = {
    paragraph: { source, context: "p" },
  };
  let calls = 0;
  await translateMessages(messages, "en", "hi", {
    key: "test-only-key",
    save: async () => {},
    fetch: async (_, options) => {
      const input = JSON.parse(String(options?.body)).input as string;
      assert.ok(input.length <= 2_000);
      assert.equal(input.includes("{{"), input.includes("}}"));
      calls += 1;
      return new Response(
        JSON.stringify({
          request_id: `chunk-${calls}`,
          translated_text:
            "नोट्स को ध्यान से पढ़ें। " +
            (input.includes("{{name}}") ? "{{name}}" : ""),
        }),
      );
    },
  });
  assert.ok(calls > 1);
  assert.match(messages.paragraph!.translation!, /\{\{name\}\}/);
});

test("preserves nested emphasis and comments and translates bare text nodes", () => {
  const parsed = extractHtml(
    "<div>Home</div><p>Read <strong>Guide</strong> carefully.<!--keep--></p>",
    "en",
  );
  const plain = parsed.units.find((unit) => unit.source === "Home")!;
  plain.apply(translations.Home!);
  const formatted = parsed.units.find((unit) =>
    unit.source.startsWith("Read"),
  )!;
  const value =
    "{{SEER_HTML_0}}मार्गदर्शिका{{SEER_HTML_1}} को ध्यान से पढ़ें।{{SEER_HTML_2}}";
  checkTranslation(formatted.source, value, "en", "hi");
  formatted.apply(value);
  assert.match(serialize(parsed.document), /<div>मुखपृष्ठ<\/div>/);
  assert.match(serialize(parsed.document), /<strong>मार्गदर्शिका<\/strong>/);
  assert.match(serialize(parsed.document), /<!--keep-->/);
  assert.throws(
    () => formatted.apply("{{SEER_HTML_1}}{{SEER_HTML_0}}{{SEER_HTML_2}}"),
    /boundaries/,
  );
  assert.throws(() => formatted.apply("{{SEER_HTML_0}}"), /open/);
});

test("validates localization configuration before translation work", () => {
  assert.throws(
    () =>
      parseConfig(
        configuration.replace(
          'strategy = "subdirectory"',
          'strategy = "cookie"',
        ),
      ),
    /strategy/,
  );
  assert.throws(
    () => parseConfig(configuration.replace('["en", "hi"]', '["hi"]')),
    /source locale/,
  );
  assert.throws(
    () =>
      parseConfig(configuration.replace('["en", "hi"]', '["en", "hi", "hi"]')),
    /unique locales/,
  );
  assert.throws(
    () =>
      parseConfig(
        configuration.replace('[routing]\nstrategy = "subdirectory"\n', ""),
      ),
    /routing/,
  );
  assert.throws(() => sarvamLanguage("es"), /catalog/);
  assert.throws(() => checkTranslation("Hello", "", "en", "hi"), /empty/);
});

test("uses the CLI for extraction and an offline build", async (t) => {
  const root = await fixture(t);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const run = promisify(execFile);
  const extracted = await run(
    process.execPath,
    [cli, "localize", "--extract"],
    { cwd: root },
  );
  assert.match(extracted.stdout, /hi: .* translations needed/);
  await fill(root);
  const built = await run(
    process.execPath,
    [cli, "localize", "--dir", "locales"],
    { cwd: root },
  );
  assert.match(built.stdout, /2 locales, 2 pages/);
});

test("builds through the provider seam and retains its request provenance", async (t) => {
  const root = await fixture(t);
  const dir = resolve(root, "locales");
  await localize({
    dir,
    translate: true,
    key: "test-only-key",
    fetch: async (_, options) => {
      let text = JSON.parse(String(options?.body)).input as string;
      for (const [source, translated] of Object.entries(translations))
        text = text.replaceAll(source, translated);
      return new Response(
        JSON.stringify({ request_id: "local-fixture", translated_text: text }),
      );
    },
  });
  const catalog = JSON.parse(await readFile(resolve(dir, "hi.json"), "utf8"));
  assert.ok(
    Object.values(catalog.messages).every(
      (message) => (message as Message).requestId === "local-fixture",
    ),
  );
});

test("restores the previous published site if replacing it fails", async (t) => {
  const root = await fixture(t);
  const dir = resolve(root, "locales");
  await localize({ dir, extract: true });
  await fill(root);
  await localize({ dir });
  const before = await readFile(resolve(root, "public/hi/index.html"), "utf8");
  const original = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (
      String(from).replaceAll("\\", "/").includes("/.seer/site-") &&
      String(to).replaceAll("\\", "/").endsWith("/public")
    )
      throw new Error("simulated replacement failure");
    return original(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(localize({ dir }), /simulated replacement failure/);
  } finally {
    fs.promises.rename = original;
    syncBuiltinESMExports();
  }
  assert.equal(
    await readFile(resolve(root, "public/hi/index.html"), "utf8"),
    before,
  );
});

test("rejects malformed and oversized provider responses without saving", async () => {
  for (const body of ["{}", "x".repeat(100_001)]) {
    await assert.rejects(
      translateMessages(
        { home: { source: "Home", context: "a" } },
        "en",
        "hi",
        {
          key: "test-only-key",
          fetch: async () => new Response(body),
          save: async () => assert.fail("bad output must not be saved"),
        },
      ),
      /invalid|oversized/,
    );
  }
  await assert.rejects(
    translateMessages({}, "en", "hi", { key: "", save: async () => {} }),
    /SARVAM_API_KEY/,
  );
});

test("rejects reserved placeholders in inline source text without rejecting protected code", () => {
  for (const marker of ["{{SEER_TERM_0}}", "{{SEER_HTML_0}}"])
    assert.throws(
      () => extractHtml(`<p>Read <em>${marker}</em></p>`, "en"),
      /reserved placeholder/,
    );
  const parsed = extractHtml("<p>Read <code>{{SEER_TERM_0}}</code></p>", "en");
  parsed.units[0]!.apply("पढ़ें {{SEER_HTML_0}}");
  assert.match(serialize(parsed.document), /<code>\{\{SEER_TERM_0\}\}<\/code>/);
});

test("keeps case-insensitive noindex and none pages out of localization and sitemaps", async (t) => {
  const root = await fixture(t);
  for (const [index, directive] of ["NOINDEX", "NoIndex, follow", "none"].entries())
    await writeFile(
      resolve(root, `source/private-${index}.html`),
      `<html><head><meta name="ROBOTS" content="${directive}"></head><body>Private draft</body></html>`,
    );
  const dir = resolve(root, "locales");
  assert.equal((await localize({ dir, extract: true })).pages, 2);
  await fill(root);
  await localize({ dir });
  assert.doesNotMatch(await readFile(resolve(root, "public/sitemap.xml"), "utf8"), /private/);
  assert.match(await readFile(resolve(root, "public/private-0.html"), "utf8"), /NOINDEX/);
});

test("preserves relative responsive images and CSS while localizing index and fragment links", async (t) => {
  const root = await fixture(t);
  const path = resolve(root, "source/index.html");
  await writeFile(path, (await readFile(path, "utf8")).replace("</body>",
    '<img srcset="assets/logo.svg 1x, assets/logo.svg 2x"><div style="background:url(assets/logo.svg)"></div><style>.logo{background:url(assets/logo.svg)}</style><a href="guide/index.html?mode=print#types">Guide</a><a href="#intro">Home</a></body>',
  ));
  const dir = resolve(root, "locales");
  await localize({ dir, extract: true });
  await fill(root);
  await localize({ dir });
  const html = await readFile(resolve(root, "public/hi/index.html"), "utf8");
  assert.match(html, /<base href="https:\/\/example.test\/notes\/">/);
  assert.match(html, /srcset="assets\/logo.svg 1x, assets\/logo.svg 2x"/);
  assert.match(html, /background:url\(assets\/logo.svg\)/);
  assert.match(html, /href="https:\/\/example.test\/notes\/hi\/guide\/\?mode=print#types"/);
  assert.match(html, /href="https:\/\/example.test\/notes\/hi\/#intro"/);
});

test("honors existing document bases when relocating relative assets", async (t) => {
  for (const base of ["/notes/guide/", "https://cdn.example.test/static/"]) {
    const root = await fixture(t);
    const path = resolve(root, "source/index.html");
    await writeFile(path, (await readFile(path, "utf8")).replace("<head>", `<head><base href="${base}">`));
    const dir = resolve(root, "locales");
    await localize({ dir, extract: true });
    await fill(root);
    await localize({ dir });
    const html = await readFile(resolve(root, "public/hi/index.html"), "utf8");
    const expected = base.startsWith("/") ? "https://example.test/notes/guide/" : base;
    assert.ok(html.includes(`<base href="${expected}">`));
    assert.ok(html.includes(`src="${expected}assets/logo.svg"`));
  }
});

test("cancels oversized provider streams before buffering the whole response", async () => {
  let chunks = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++chunks > 4) controller.close();
      else controller.enqueue(new Uint8Array(60_000).fill(65));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(translateMessages({ home: { source: "Home", context: "a" } }, "en", "hi", {
    key: "test-only-key",
    fetch: async () => new Response(body),
    save: async () => assert.fail("oversized output must not be saved"),
  }), /oversized/);
  assert.equal(cancelled, true);
  assert.equal(chunks, 2);
});

test("includes excluded HTML in every subdomain deployment with shared asset URLs", async (t) => {
  const root = await fixture(t, "subdomain");
  await writeFile(resolve(root, "source/404.html"), '<html><body>Missing page<img src="assets/logo.svg"></body></html>');
  const dir = resolve(root, "locales");
  await localize({ dir, extract: true });
  await fill(root);
  await localize({ dir });
  for (const locale of ["en", "hi"]) {
    const html = await readFile(resolve(root, `public/${locale}/404.html`), "utf8");
    assert.match(html, /Missing page/);
    assert.match(html, /src="https:\/\/example.test\/notes\/assets\/logo.svg"/);
    assert.doesNotMatch(await readFile(resolve(root, `public/${locale}/sitemap.xml`), "utf8"), /404/);
  }
});

test("reports invalid HTML language tags and respects case-insensitive translation opt-outs", () => {
  assert.throws(() => extractHtml('<p lang="en_US">Home</p>', "en"), /invalid HTML language tag/);
  assert.equal(extractHtml('<p translate="NO">Home</p>', "en").units.length, 0);
});
