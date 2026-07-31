import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import {
  headData,
  readProject,
  robotsTxt,
  serializeJsonLd,
  sitemapXml,
  type Json,
  type JsonObject,
  type PageSeo,
  type Project,
} from "../src/index.js";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = resolve(repository, "dist/src/cli.js");

async function fixture(context: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "seer-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await cp(resolve(repository, "content"), resolve(root, "content"), {
    recursive: true,
  });
  return root;
}

async function editConfig(root: string, change: (source: string) => string) {
  const path = resolve(root, "content/config.toml");
  await writeFile(path, change(await readFile(path, "utf8")));
}

async function editJson(
  root: string,
  locale: string,
  change: (value: Record<string, any>) => void,
) {
  const path = resolve(root, `content/${locale}.json`);
  const value = JSON.parse(await readFile(path, "utf8"));
  change(value);
  await writeFile(path, JSON.stringify(value));
}

async function editLocales(
  root: string,
  change: (value: Record<string, any>, locale: string) => void,
) {
  await Promise.all(["en", "es"].map((locale) =>
    editJson(root, locale, (value) => change(value, locale)),
  ));
}

function page(path: string, overrides: Partial<PageSeo> = {}): PageSeo {
  return {
    path,
    title: path,
    description: path,
    noindex: false,
    ...overrides,
  };
}

function project(
  pages: Record<string, PageSeo>,
  siteUrl = "https://example.com/",
): Project {
  return {
    root: repository,
    config: {
      defaultLocale: "en",
      site: { name: "Example", url: siteUrl },
      output: { publicDir: "public" },
      robots: { disallow: [], blockAgents: [] },
    },
    locales: ["en"],
    content: { en: {} },
    pages: { en: pages },
  };
}

test("loads independent locales and generates safe metadata", async (context) => {
  const root = await fixture(context);
  const nestedText = `${"[{".repeat(66)}\\\"${"}]".repeat(66)}`;
  await editLocales(root, (content) => { content.home.summary = nestedText; });
  const loaded = await readProject({ dir: resolve(root, "content") });
  const data = headData(loaded, "es", "home");
  const robots = robotsTxt(loaded);

  assert.equal((loaded.content.es?.brand as JsonObject).name, "Seer");
  assert.equal((loaded.content.en?.home as JsonObject).summary, nestedText);
  assert.notEqual(loaded.content.en?.brand, loaded.content.es?.brand);
  (loaded.content.en?.brand as JsonObject).name = "Changed";
  assert.equal((loaded.content.es?.brand as JsonObject).name, "Seer");
  assert.equal(data.alternates["x-default"], "https://keys-i.github.io/seer/");
  assert.equal(data.canonical, "https://keys-i.github.io/seer/es/");
  assert.equal(data.dir, "ltr");
  assert.match(sitemapXml(loaded), /<loc>https:\/\/keys-i\.github\.io\/seer\/es\/<\/loc>/);
  assert.match(robots, /User-agent: GPTBot\nDisallow: \/seer\//);
  assert.doesNotMatch(robots, /Allow: \//);
  for (const value of ["</script>", "</ScRiPt><!--", "\u2028\u2029<"]) {
    assert.doesNotMatch(serializeJsonLd({ value }), /</);
  }
  for (const id of Object.getOwnPropertyNames(Object.prototype)) {
    assert.throws(() => headData(loaded, "en", id), /unknown page/);
  }
  for (const locale of Object.getOwnPropertyNames(Object.prototype)) {
    for (const id of ["name", "length"]) {
      assert.throws(() => headData(loaded, locale, id), /unknown page/);
    }
  }
});

test("supports an HTTPS base path", async (context) => {
  const root = await fixture(context);
  await editConfig(root, (source) =>
    source.replace("https://keys-i.github.io/seer/", "https://example.com/base/"),
  );
  const loaded = await readProject({ dir: resolve(root, "content") });

  assert.equal(
    headData(loaded, "es", "home").canonical,
    "https://example.com/base/es/",
  );
  assert.match(robotsTxt(loaded), /Disallow: \/base\/api\//);
  assert.match(robotsTxt(loaded), /Sitemap: https:\/\/example\.com\/base\/sitemap\.xml/);
});

test("keeps scheme-like page and image paths inside the site base", async (context) => {
  const root = await fixture(context);
  const paths = [
    "/https://evil.test/pwn",
    "/http://evil.test/pwn",
    "/javascript:alert(1)",
    "/data:text/html,pwn",
  ];
  await editConfig(root, (source) =>
    source.replace("https://keys-i.github.io/seer/", "https://example.com/base/"),
  );
  await editLocales(root, (content, locale) => {
    const pages = content.seo.pages;
    const offset = locale === "en" ? 0 : 2;
    pages.home.path = paths[offset];
    pages.docs.path = paths[offset + 1];
    pages.home.image = "/javascript:alert(1)";
    pages.home.image_alt = "Safe base-relative image";
  });

  const loaded = await readProject({ dir: resolve(root, "content") });
  for (const locale of loaded.locales) {
    for (const pageId of Object.keys(loaded.pages[locale]!)) {
      const metadata = headData(loaded, locale, pageId);
      assert.ok(metadata.canonical.startsWith("https://example.com/base/"));
      if (metadata.image) {
        assert.ok(metadata.image.startsWith("https://example.com/base/"));
      }
    }
  }
  for (const loc of sitemapXml(loaded).matchAll(/<loc>(.*?)<\/loc>/g)) {
    assert.ok(loc[1]!.startsWith("https://example.com/base/"));
  }
});

test("awaits validation without cross-locale mutation", async (context) => {
  const root = await fixture(context);
  const calls: string[] = [];
  const loaded = await readProject({
    dir: resolve(root, "content"),
    async validate(content, locale) {
      await Promise.resolve();
      calls.push(locale);
      const brand = content.brand as JsonObject;
      if (locale === "en") brand.name = "Validated";
      else assert.equal(brand.name, "Seer");
    },
  });

  assert.deepEqual(calls, ["en", "es"]);
  assert.equal((loaded.content.en?.brand as JsonObject).name, "Validated");
  assert.equal((loaded.content.es?.brand as JsonObject).name, "Seer");
  await assert.rejects(
    readProject({
      dir: resolve(root, "content"),
      validate: async (_content, locale) => {
        if (locale === "es") throw new Error("invalid es");
      },
    }),
    /invalid es/,
  );
});

test("rejects invalid configuration with table-driven checks", async (context) => {
  const cases = [
    {
      name: "unknown key",
      change: (source: string) => `${source}\nunknown = true\n`,
      error: /config\.robots\.unknown is not supported/,
    },
    {
      name: "wrong version",
      change: (source: string) => source.replace("version = 1", "version = 2"),
      error: /config\.version must be 1/,
    },
    ...([
      ["date", "1979-05-27"],
      ["datetime", "1979-05-27T07:32:00Z"],
      ["time", "07:32:00"],
      ["boolean", "false"],
      ["integer", "0"],
      ["string", '""'],
    ] as const).flatMap(([name, value]) =>
      (["output", "robots"] as const).map((field) => ({
        name: `${field} ${name} scalar`,
        change: () => [
          "version = 1",
          'default_locale = "en"',
          `${field} = ${value}`,
          "",
          "[site]",
          'name = "Seer Example"',
          'url = "https://keys-i.github.io/seer/"',
          "",
        ].join("\n"),
        error: new RegExp(`config\\.${field} must be an object`),
      })),
    ),
    {
      name: "HTTP site",
      change: (source: string) => source.replace("https://", "http://"),
      error: /must use HTTPS/,
    },
    {
      name: "malformed site URL",
      change: (source: string) =>
        source.replace("https://keys-i.github.io/seer/", "not a URL"),
      error: /must be a valid URL/,
    },
    {
      name: "blank site name",
      change: (source: string) =>
        source.replace('name = "Seer Example"', 'name = " "'),
      error: /site\.name must be a non-empty string/,
    },
    {
      name: "credentials",
      change: (source: string) =>
        source.replace("https://keys-i.github.io/seer/", "https://user@example.com/"),
      error: /must not contain credentials/,
    },
    {
      name: "base path without slash",
      change: (source: string) =>
        source.replace("https://keys-i.github.io/seer/", "https://example.com/seer"),
      error: /base URL ending in/,
    },
    ...(["|", "[", "]"] as const).map((character) => ({
      name: `unsafe site path ${character}`,
      change: (source: string) => source.replace(
        "https://keys-i.github.io/seer/",
        `https://example.com/path${character}/`,
      ),
      error: /safe root-relative/,
    })),
    {
      name: "site URL control encoding",
      change: (source: string) =>
        source.replace("https://keys-i.github.io/seer/", "https://example.com/%0A/"),
      error: /unsafe URL controls/,
    },
    {
      name: "raw site URL control",
      change: (source: string) =>
        source.replace("https://keys-i.github.io/seer/", "\\u001Bhttps://example.com/"),
      error: /unsafe URL controls/,
    },
    {
      name: "malformed site URL encoding",
      change: (source: string) =>
        source.replace("https://keys-i.github.io/seer/", "https://example.com/%/"),
      error: /valid URL encoding/,
    },
    {
      name: "absolute output",
      change: (source: string) =>
        source.replace('public_dir = "public"', 'public_dir = "/tmp"'),
      error: /must be a subdirectory/,
    },
    {
      name: "drive-relative output",
      change: (source: string) =>
        source.replace('public_dir = "public"', 'public_dir = "C:output"'),
      error: /must be a subdirectory/,
    },
    {
      name: "Windows-aliased output",
      change: (source: string) =>
        source.replace('public_dir = "public"', 'public_dir = "content."'),
      error: /must be a subdirectory/,
    },
    {
      name: "Windows leading-space alias",
      change: (source: string) =>
        source.replace('public_dir = "public"', 'public_dir = " content"'),
      error: /must be a subdirectory/,
    },
    {
      name: "Windows-reserved output",
      change: (source: string) =>
        source.replace('public_dir = "public"', 'public_dir = "NUL/cache"'),
      error: /must be a subdirectory/,
    },
    {
      name: "Windows alternate-data output",
      change: (source: string) =>
        source.replace('public_dir = "public"', 'public_dir = "public:cache"'),
      error: /must be a subdirectory/,
    },
    ...(["\\u009B", "\\u202E"] as const).map((control) => ({
      name: `unsafe output control ${control}`,
      change: (source: string) =>
        source.replace('public_dir = "public"', `public_dir = "${control}"`),
      error: /must be a subdirectory/,
    })),
    ...([
      ["oversized output component", "a".repeat(256)],
      ["excessive output depth", Array(33).fill("a").join("/")],
    ] as const).map(([name, output]) => ({
      name,
      change: (source: string) =>
        source.replace('public_dir = "public"', `public_dir = "${output}"`),
      error: /must be a subdirectory/,
    })),
    {
      name: "non-string output",
      change: (source: string) =>
        source.replace('public_dir = "public"', "public_dir = 1"),
      error: /must be a non-empty string/,
    },
    {
      name: "overlapping output",
      change: (source: string) =>
        source.replace('public_dir = "public"', 'public_dir = "content/generated"'),
      error: /must not overlap/,
    },
    {
      name: "backslash-normalized absolute output",
      change: (source: string) =>
        source.replace(
          'public_dir = "public"',
          String.raw`public_dir = '\public'`,
        ),
      error: /must be a subdirectory/,
    },
    {
      name: "crawler token with digit",
      change: (source: string) => source.replace("GPTBot", "GPTBot2"),
      error: /invalid crawler token/,
    },
    {
      name: "robots list is not an array",
      change: (source: string) =>
        source.replace(
          'disallow = ["/api/", "/admin/"]',
          'disallow = "/api/"',
        ),
      error: /must be an array/,
    },
    {
      name: "malformed robots encoding",
      change: (source: string) => source.replace("/api/", "/bad%"),
      error: /valid URL encoding/,
    },
    {
      name: "robots path with space",
      change: (source: string) => source.replace("/api/", "/api private/"),
      error: /valid robots path pattern/,
    },
    {
      name: "noncanonical default locale",
      change: (source: string) =>
        source.replace('default_locale = "en"', 'default_locale = "EN"'),
      error: /locale must be canonical/,
    },
    {
      name: "oversized locale filename",
      change: (source: string) => source.replace(
        'default_locale = "en"',
        `default_locale = "en-x-${Array(27).fill("aaaaaaaa").join("-")}-aaa"`,
      ),
      error: /unsafe locale name/,
    },
    ...(["con", "prn", "aux", "nul"] as const).map((locale) => ({
      name: `Windows-reserved locale ${locale}`,
      change: (source: string) =>
        source.replace('default_locale = "en"', `default_locale = "${locale}"`),
      error: /unsafe locale name/,
    })),
    {
      name: "missing default locale",
      change: (source: string) =>
        source.replace('default_locale = "en"', 'default_locale = "fr"'),
      error: /missing default locale file/,
    },
  ] as const;

  for (const item of cases) {
    await context.test(item.name, async (nested) => {
      const root = await fixture(nested);
      await editConfig(root, item.change);
      await assert.rejects(
        readProject({ dir: resolve(root, "content") }),
        item.error,
      );
    });
  }
});

test("accepts robot query patterns and removes duplicate rules", async (context) => {
  const root = await fixture(context);
  await editConfig(root, (source) =>
    source
      .replace(
        'disallow = ["/api/", "/admin/"]',
        'disallow = ["/search?q=*", "/search?q=*"]',
      )
      .replace(
        'block_agents = ["GPTBot", "ClaudeBot"]',
        'block_agents = ["GPTBot", "gptbot"]',
      ),
  );
  const loaded = await readProject({ dir: resolve(root, "content") });
  assert.equal(loaded.config.robots.disallow.length, 1);
  assert.equal(loaded.config.robots.blockAgents.length, 1);
  assert.match(robotsTxt(loaded), /Disallow: \/seer\/search\?q=\*/);
});

test("uses optional configuration defaults and file URLs", async (context) => {
  const root = await fixture(context);
  await editConfig(root, (source) => source.replace(/\n\[output\][\s\S]*$/, "\n"));
  const loaded = await readProject({
    dir: pathToFileURL(resolve(root, "content")),
  });

  assert.equal(loaded.config.output.publicDir, "public");
  assert.deepEqual(loaded.config.robots, { disallow: [], blockAgents: [] });
  assert.match(robotsTxt(loaded), /User-agent: \*\nDisallow:\n/);
});

test("rejects malformed content schemas", async (context) => {
  const cases: Array<{
    name: string;
    prepare: (root: string) => Promise<void>;
    error: RegExp;
  }> = [
    {
      name: "invalid JSON",
      prepare: (root) => writeFile(resolve(root, "content/en.json"), "{"),
      error: /is invalid JSON/,
    },
    {
      name: "non-object shared root",
      prepare: (root) => writeFile(resolve(root, "content/shared.json"), "[]"),
      error: /must be an object/,
    },
    {
      name: "blank page title",
      prepare: (root) => editLocales(root, (content) => {
        content.seo.pages.home.title = " ";
      }),
      error: /title must be a non-empty string/,
    },
    {
      name: "non-string image",
      prepare: (root) => editLocales(root, (content) => {
        content.seo.pages.home.image = 1;
        content.seo.pages.home.image_alt = "Image";
      }),
      error: /image must be a non-empty string/,
    },
    {
      name: "image URL control encoding",
      prepare: (root) => editLocales(root, (content) => {
        content.seo.pages.home.image = "/image%0A.png";
        content.seo.pages.home.image_alt = "Image";
      }),
      error: /unsafe URL controls/,
    },
    {
      name: "raw image URL control",
      prepare: (root) => editLocales(root, (content) => {
        content.seo.pages.home.image = "/foo\nbar.png";
        content.seo.pages.home.image_alt = "Image";
      }),
      error: /unsafe URL controls/,
    },
    {
      name: "non-boolean noindex",
      prepare: (root) => editLocales(root, (content) => {
        content.seo.pages.home.noindex = "false";
      }),
      error: /noindex must be boolean/,
    },
    {
      name: "unsafe page ID",
      prepare: (root) => editLocales(root, (content) => {
        content.seo.pages._home = content.seo.pages.home;
        delete content.seo.pages.home;
      }),
      error: /unsafe page id/,
    },
    {
      name: "unknown page field",
      prepare: (root) => editLocales(root, (content) => {
        content.seo.pages.home.unknown = true;
      }),
      error: /unknown is not supported/,
    },
    {
      name: "duplicate path within locale",
      prepare: (root) => editLocales(root, (content) => {
        content.seo.pages.docs.path = content.seo.pages.home.path;
      }),
      error: /duplicate canonical URL/,
    },
    {
      name: "array length mismatch",
      prepare: async (root) => {
        await editJson(root, "en", (content) => { content.items = [1]; });
        await editJson(root, "es", (content) => { content.items = [1, 2]; });
      },
      error: /es\.json differs at \$\.items/,
    },
    {
      name: "array member mismatch",
      prepare: async (root) => {
        await editJson(root, "en", (content) => { content.items = [1]; });
        await editJson(root, "es", (content) => { content.items = ["1"]; });
      },
      error: /es\.json differs at \$\.items\[0\]/,
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async (nested) => {
      const root = await fixture(nested);
      await item.prepare(root);
      await assert.rejects(
        readProject({ dir: resolve(root, "content") }),
        item.error,
      );
    });
  }
});

test("rejects locale discovery edge cases", async (context) => {
  await context.test("invalid locale tag", async (nested) => {
    const root = await fixture(nested);
    await rename(
      resolve(root, "content/es.json"),
      resolve(root, "content/en-.json"),
    );
    await assert.rejects(
      readProject({ dir: resolve(root, "content") }),
      /invalid locale/,
    );
  });

  await context.test("no locale files", async (nested) => {
    const root = await fixture(nested);
    await Promise.all([
      rm(resolve(root, "content/en.json")),
      rm(resolve(root, "content/es.json")),
    ]);
    await assert.rejects(
      readProject({ dir: resolve(root, "content") }),
      /at least one locale/,
    );
  });

  await context.test("symlinked config", async (nested) => {
    const root = await fixture(nested);
    const config = resolve(root, "content/config.toml");
    const real = resolve(root, "config.toml");
    await rename(config, real);
    await symlink(real, config);
    await assert.rejects(
      readProject({ dir: resolve(root, "content") }),
      /config\.toml must be a regular file/,
    );
  });

  for (const [name, expected, alias] of [
    ["config filename", "config.toml", "CONFIG.TOML"],
    ["shared filename", "shared.json", "SHARED.JSON"],
  ] as const) {
    await context.test(name, async (nested) => {
      const root = await fixture(nested);
      await rename(
        resolve(root, `content/${expected}`),
        resolve(root, `content/${alias}`),
      );
      await assert.rejects(
        readProject({ dir: resolve(root, "content") }),
        /canonical filename|ENOENT/,
      );
    });
  }
});

test("validates post-callback page shape", async (context) => {
  const root = await fixture(context);
  await assert.rejects(
    readProject({
      dir: resolve(root, "content"),
      validate(content, locale) {
        if (locale === "es") {
          delete ((content.seo as JsonObject).pages as JsonObject).docs;
        }
      },
    }),
    /es\.json differs at \$\.seo\.pages/,
  );
});

test("rejects validator corruption", async (context) => {
  const cases: Array<{
    name: string;
    corrupt: (content: JsonObject) => void;
    error: RegExp;
  }> = [
    {
      name: "non-finite number",
      corrupt: (content) => { content.invalid = Infinity; },
      error: /number that JSON cannot preserve/,
    },
    {
      name: "undefined",
      corrupt: (content) => {
        (content as Record<string, unknown>).invalid = undefined;
      },
      error: /is not valid JSON/,
    },
    {
      name: "prototype mutation",
      corrupt: (content) => { Object.setPrototypeOf(content, { polluted: true }); },
      error: /invalid object prototype/,
    },
    {
      name: "circular reference",
      corrupt: (content) => { content.circular = content; },
      error: /circular reference/,
    },
    {
      name: "array prototype mutation",
      corrupt: (content) => {
        const value = [1];
        Object.setPrototypeOf(value, null);
        content.invalid = value;
      },
      error: /invalid array structure/,
    },
    {
      name: "sparse array",
      corrupt: (content) => { content.invalid = new Array<number>(1); },
      error: /invalid array structure/,
    },
    {
      name: "excessive depth",
      corrupt: (content) => {
        let value: Json = 0;
        for (let depth = 0; depth < 65; depth += 1) value = [value];
        content.invalid = value;
      },
      error: /maximum depth of 64/,
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async (nested) => {
      const root = await fixture(nested);
      await assert.rejects(
        readProject({
          dir: resolve(root, "content"),
          validate(content, locale) {
            if (locale === "en") item.corrupt(content);
          },
        }),
        item.error,
      );
    });
  }

  const retainedCases: Array<{
    name: string;
    corrupt: (content: JsonObject) => void;
    error: RegExp;
  }> = [
    {
      name: "retained lone surrogate",
      corrupt: (content) => { (content.home as JsonObject).heading = "\ud800"; },
      error: /invalid Unicode/,
    },
    {
      name: "retained non-finite number",
      corrupt: (content) => { (content.home as JsonObject).heading = Infinity; },
      error: /number that JSON cannot preserve/,
    },
    {
      name: "retained oversized string",
      corrupt: (content) => {
        (content.home as JsonObject).heading = "x".repeat(50 * 1024 * 1024);
      },
      error: /generated content exceeds the 50 MiB limit/,
    },
  ];

  for (const item of retainedCases) {
    await context.test(item.name, async (nested) => {
      const root = await fixture(nested);
      let retained: JsonObject | undefined;
      await assert.rejects(
        readProject({
          dir: resolve(root, "content"),
          validate(content, locale) {
            if (locale === "en") retained = content;
            else item.corrupt(retained!);
          },
        }),
        item.error,
      );
    });
  }

  await context.test("locale shape mutation", async (nested) => {
    const root = await fixture(nested);
    await assert.rejects(
      readProject({
        dir: resolve(root, "content"),
        validate(content, locale) {
          if (locale === "es") delete content.navigation;
        },
      }),
      /es\.json differs at \$/,
    );
  });
});

test("merges overlapping shared primitives without aliasing", async (context) => {
  const root = await fixture(context);
  await editLocales(root, (content, locale) => {
    content.brand = { name: locale };
  });
  const loaded = await readProject({ dir: resolve(root, "content") });
  assert.equal((loaded.content.en?.brand as JsonObject).name, "en");
  assert.equal((loaded.content.es?.brand as JsonObject).name, "es");
});

test("rejects corrupt or lossy JSON values", async (context) => {
  const cases = [
    {
      name: "non-finite number",
      value: "1e400",
      error: /number that JSON cannot preserve/,
    },
    {
      name: "unsafe integer",
      value: "9007199254740993",
      error: /number that JSON cannot preserve/,
    },
    {
      name: "negative zero",
      value: "-0",
      error: /number that JSON cannot preserve/,
    },
    {
      name: "lone surrogate",
      value: '"\\ud800"',
      error: /invalid Unicode/,
    },
    {
      name: "prototype key",
      value: '{"__proto__":{}}',
      error: /__proto__ is forbidden/,
    },
    {
      name: "control character key",
      value: '{"line\\nbreak":1}',
      error: /invalid JSON key/,
    },
    {
      name: "format character key",
      value: '{"\\u202eoverride":1}',
      error: /invalid JSON key/,
    },
    {
      name: "excessive depth",
      value: `${"[".repeat(65)}0${"]".repeat(65)}`,
      error: /maximum depth of 64/,
    },
  ] as const;

  for (const item of cases) {
    await context.test(item.name, async (nested) => {
      const root = await fixture(nested);
      const path = resolve(root, "content/en.json");
      const source = await readFile(path, "utf8");
      await writeFile(
        path,
        source.replace(
          /"summary": "[^"]+"/,
          `"summary": ${item.value}`,
        ),
      );
      await assert.rejects(
        readProject({ dir: resolve(root, "content") }),
        item.error,
      );
    });
  }

  await context.test("malformed UTF-8", async (nested) => {
    const root = await fixture(nested);
    await writeFile(
      resolve(root, "content/en.json"),
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d]),
    );
    await assert.rejects(
      readProject({ dir: resolve(root, "content") }),
      /must be valid UTF-8/,
    );
  });
});

test("rejects noncanonical page paths", async (context) => {
  const cases = [
    { name: "relative", value: "relative", error: /safe root-relative/ },
    { name: "network path", value: "//other.example/path", error: /safe root-relative/ },
    { name: "dot segment", value: "/./path", error: /safe root-relative/ },
    { name: "encoded dot segment", value: "/%2e%2e/path", error: /canonical URL encoding/ },
    { name: "encoded unreserved", value: "/%61", error: /canonical URL encoding/ },
    { name: "encoded slash", value: "/encoded%2fslash", error: /canonical URL encoding/ },
    { name: "malformed encoding", value: "/bad%", error: /valid URL encoding/ },
    { name: "encoded NUL", value: "/%00", error: /safe root-relative/ },
    { name: "encoded newline", value: "/%0A", error: /safe root-relative/ },
    { name: "encoded DEL", value: "/%7F", error: /safe root-relative/ },
    { name: "encoded C1", value: "/%C2%9B", error: /safe root-relative/ },
    { name: "encoded bidi", value: "/%E2%80%AE", error: /safe root-relative/ },
    { name: "raw C1", value: "/\u009b", error: /safe root-relative/ },
    { name: "raw bidi", value: "/\u202e", error: /safe root-relative/ },
    ...[" ", '"', "<", ">", "[", "]", "^", "`", "{", "|", "}"].map(
      (character) => ({
        name: `raw unsafe ASCII ${JSON.stringify(character)}`,
        value: `/path${character}`,
        error: /safe root-relative/,
      }),
    ),
  ] as const;

  for (const { name, value, error } of cases) {
    await context.test(name, async (nested) => {
      const root = await fixture(nested);
      await editJson(root, "en", (content) => {
        content.seo.pages.home.path = value;
      });
      await assert.rejects(
        readProject({ dir: resolve(root, "content") }),
        error,
      );
    });
  }
});

test("rejects inconsistent locale content", async (context) => {
  const cases: Array<{
    name: string;
    change: (content: Record<string, any>) => void;
    prepare?: (root: string) => Promise<void>;
    error: RegExp;
  }> = [
    {
      name: "missing translation",
      change: (content) => delete content.home.summary,
      error: /es\.json differs at \$\.home/,
    },
    {
      name: "different noindex policy",
      change: (content) => { content.seo.pages.home.noindex = true; },
      prepare: (root) => editJson(root, "en", (content) => {
        content.seo.pages.home.noindex = false;
      }),
      error: /noindex must match across locales/,
    },
    {
      name: "duplicate canonical",
      change: (content) => { content.seo.pages.home.path = "/"; },
      error: /duplicate canonical URL/,
    },
    {
      name: "image without alt",
      change: (content) => { content.seo.pages.home.image = "/og.png"; },
      prepare: (root) => editJson(root, "en", (content) => {
        content.seo.pages.home.image = "/og.png";
      }),
      error: /image and image_alt must be set together/,
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async (nested) => {
      const root = await fixture(nested);
      await item.prepare?.(root);
      await editJson(root, "es", item.change);
      await assert.rejects(
        readProject({ dir: resolve(root, "content") }),
        item.error,
      );
    });
  }
});

test("rejects symlinked input boundaries", async (context) => {
  await context.test("content directory", async (nested) => {
    const root = await fixture(nested);
    const link = resolve(root, "linked-content");
    await symlink(resolve(root, "content"), link);
    await assert.rejects(readProject({ dir: link }), /must be a real directory/);
    await assert.rejects(
      readProject({ dir: pathToFileURL(`${link}/`) }),
      /must be a real directory/,
    );
  });

  await context.test("locale file", async (nested) => {
    const root = await fixture(nested);
    const target = resolve(root, "content/es.json");
    await rm(target);
    await symlink(resolve(root, "content/en.json"), target);
    await assert.rejects(
      readProject({ dir: resolve(root, "content") }),
      /es\.json must be a regular file/,
    );
  });
});

test("enforces input resource limits", async (context) => {
  await context.test("portable output path", async (nested) => {
    const root = await fixture(nested);
    const component = "a".repeat(250);
    const output = Array(4).fill(component).join("/");
    await editConfig(root, (source) =>
      source.replace('public_dir = "public"', `public_dir = "${output}"`),
    );
    await assert.rejects(
      exec(process.execPath, [cli, "check", "--dir", resolve(root, "content")]),
      /must be a subdirectory/,
    );
    await assert.rejects(access(resolve(root, ".seer")));
    await assert.rejects(access(resolve(root, component)));
  });

  await context.test("configuration bytes", async (nested) => {
    const root = await fixture(nested);
    await writeFile(
      resolve(root, "content/config.toml"),
      "#".repeat(256 * 1024 + 1),
    );
    await assert.rejects(
      readProject({ dir: resolve(root, "content") }),
      /exceeds its byte limit/,
    );
  });

  await context.test("JSON file bytes", async (nested) => {
    const root = await fixture(nested);
    await writeFile(
      resolve(root, "content/shared.json"),
      Buffer.alloc(5 * 1024 * 1024 + 1, 0x20),
    );
    await assert.rejects(
      readProject({ dir: resolve(root, "content") }),
      /exceeds its byte limit/,
    );
  });

  await context.test("pre-parse JSON depth", async (nested) => {
    const root = await fixture(nested);
    await writeFile(
      resolve(root, "content/shared.json"),
      `${"[".repeat(2_000_000)}0${"]".repeat(2_000_000)}`,
    );
    await assert.rejects(
      exec(
        process.execPath,
        ["--max-old-space-size=64", cli, "check", "--dir", resolve(root, "content")],
        { timeout: 5_000 },
      ),
      (error: unknown) => {
        const failure = error as Error & { killed?: boolean; stderr?: string };
        assert.equal(failure.killed, false, "depth guard process timed out");
        assert.match(failure.stderr ?? "", /maximum depth of 64/);
        return true;
      },
    );
  });

  await context.test("aggregate JSON bytes", async (nested) => {
    const root = await fixture(nested);
    const template = JSON.parse(
      await readFile(resolve(root, "content/en.json"), "utf8"),
    );
    template.blob = "x".repeat(4_400_000);
    const locales = ["en", "es", "de", "fr", "it", "pt"];
    await Promise.all(locales.map(async (locale) => {
      const value = structuredClone(template);
      for (const [id, metadata] of Object.entries(value.seo.pages) as Array<
        [string, Record<string, unknown>]
      >) {
        metadata.path = `/${locale}/${id}/`;
      }
      await writeFile(
        resolve(root, `content/${locale}.json`),
        JSON.stringify(value),
      );
    }));
    await assert.rejects(
      readProject({ dir: resolve(root, "content") }),
      /25 MiB aggregate limit/,
    );
  });

  await context.test("locale count", async (nested) => {
    const root = await fixture(nested);
    await rm(resolve(root, "content/es.json"));
    await Promise.all(Array.from({ length: 256 }, async (_, index) => {
      const locale = `en-x-a${index.toString(36).padStart(3, "0")}`;
      await writeFile(resolve(root, `content/${locale}.json`), "{}");
    }));
    await assert.rejects(
      readProject({ dir: resolve(root, "content") }),
      /exceeds 256 locales/,
    );
  });
});

test("parser errors return instead of hanging", async (context) => {
  const root = await fixture(context);
  await writeFile(
    resolve(root, "content/config.toml"),
    "version = 1\na = [1 # unterminated",
  );
  await assert.rejects(
    exec(
      process.execPath,
      [cli, "check", "--dir", resolve(root, "content")],
      { timeout: 1_000 },
    ),
    (error: unknown) => {
      const failure = error as Error & { killed?: boolean };
      assert.equal(failure.killed, false, "parser process timed out");
      return true;
    },
  );
});

test("CLI escapes control characters in diagnostics", async (context) => {
  const cases = [
    {
      name: "JSON parser",
      poison: (root: string) =>
        writeFile(
          resolve(root, "content/en.json"),
          '{"x":\u001b[31m\u009b31m\u202eabc}',
        ),
    },
    {
      name: "TOML parser",
      poison: (root: string) =>
        writeFile(
          resolve(root, "content/config.toml"),
          "version = \u001b[31m\u009b31m\u202eabc",
        ),
    },
    {
      name: "TOML key",
      poison: (root: string) =>
        editConfig(
          root,
          (source) => `${source}\n"\\u001B[31m\\u009B31m\\u202Eabc" = 1\n`,
        ),
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async (nested) => {
      const root = await fixture(nested);
      await item.poison(root);
      await assert.rejects(
        exec(process.execPath, [cli, "check", "--dir", resolve(root, "content")]),
        (error: unknown) => {
          const stderr = (error as Error & { stderr: string }).stderr.trimEnd();
          assert.doesNotMatch(stderr, /[\p{Cc}\p{Cf}]/u);
          assert.match(stderr, /31m/);
          return true;
        },
      );
    });
  }
});

test("readProject caps expanded shared output before writing", async (context) => {
  const root = await fixture(context);
  const template = JSON.parse(
    await readFile(resolve(root, "content/en.json"), "utf8"),
  );
  const locales = ["en", "es", "de", "fr", "it", "pt", "nl", "pl", "sv", "da", "fi", "no"];
  await writeFile(
    resolve(root, "content/shared.json"),
    JSON.stringify({ blob: "x".repeat(4_500_000) }),
  );
  await Promise.all(locales.map(async (locale) => {
    const value = structuredClone(template);
    for (const [id, metadata] of Object.entries(value.seo.pages) as Array<
      [string, Record<string, unknown>]
    >) {
      metadata.path = `/${locale}/${id}/`;
    }
    await writeFile(
      resolve(root, `content/${locale}.json`),
      JSON.stringify(value),
    );
  }));

  await assert.rejects(
    readProject({ dir: resolve(root, "content") }),
    /generated content exceeds the 50 MiB limit/,
  );
  await assert.rejects(access(resolve(root, ".seer")));
});

test("robots and sitemap enforce protocol boundaries", () => {
  const rootBlocked = project({ home: page("/") });
  rootBlocked.config.robots.disallow = ["/"];
  const robots = robotsTxt(rootBlocked);
  assert.match(robots, /User-agent: \*\nDisallow: \//);
  assert.doesNotMatch(robots, /Allow:/);

  const tooManyAgents = project({ home: page("/") });
  tooManyAgents.config.robots.blockAgents = Array(20_000).fill("ExampleBot");
  assert.throws(() => robotsTxt(tooManyAgents), /500 KiB/);

  const expandedRobots = project(
    { home: page("/") },
    `https://example.com/${"a".repeat(80_000)}/`,
  );
  expandedRobots.config.robots.disallow = Array.from(
    { length: 10_000 },
    (_, index) => `/${index}`,
  );
  Object.defineProperty(expandedRobots.config.robots.disallow, 100, {
    get() { throw new Error("robots rendered past its byte limit"); },
  });
  assert.throws(() => robotsTxt(expandedRobots), /500 KiB/);

  assert.throws(
    () => sitemapXml(project({ long: page(`/${"a".repeat(2_048)}`) })),
    /shorter than 2,048/,
  );

  const expandedPages = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, index) => [`p${index}`, page(`/${index}`)]),
  );
  Object.defineProperty(expandedPages.p100, "path", {
    get() { throw new Error("sitemap rendered past its URL limit"); },
  });
  assert.throws(
    () => sitemapXml(project(
      expandedPages,
      `https://example.com/${"a".repeat(80_000)}/`,
    )),
    /shorter than 2,048/,
  );

  const pathError = new Error("URL rendered before count validation");
  const unreadable = {
    get path(): string { throw pathError; },
    title: "x",
    description: "x",
    noindex: false,
  };
  const tooMany = Object.fromEntries(
    Array.from({ length: 50_001 }, (_, index) => [`p${index}`, unreadable]),
  );
  assert.throws(() => sitemapXml(project(tooMany)), /50,000 URL/);

  const oversized = Object.fromEntries(
    Array.from({ length: 26_000 }, (_, index) => [
      `p${index}`,
      page(`/${"&".repeat(400)}${index}`),
    ]),
  );
  assert.throws(() => sitemapXml(project(oversized)), /50 MiB/);

  const escaped = sitemapXml(project({
    hidden: page("/hidden", { noindex: true }),
    quote: page("/a'b&c"),
    first: page("/a"),
  }));
  assert.doesNotMatch(escaped, /hidden/);
  assert.match(escaped, /a&apos;b&amp;c/);
  assert.ok(escaped.indexOf("https://example.com/a</loc>") < escaped.indexOf("a&apos;b"));
});

test("CLI checks, builds, and replaces only generated content", async (context) => {
  const root = await fixture(context);
  await exec(process.execPath, [cli, "check", "--dir", resolve(root, "content")]);
  await assert.rejects(access(resolve(root, ".seer")));
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
    /Sitemap: https:\/\/keys-i\.github\.io\/seer\/sitemap\.xml/,
  );
  await assert.rejects(access(resolve(root, ".seer/content/stale.json")));
  assert.equal(await readFile(resolve(root, ".keep"), "utf8"), "untouched");
});

test("CLI handles long locale names with bounded temporary names", async (context) => {
  const root = await fixture(context);
  const locale = `en-x-${Array(27).fill("aaaaaaaa").join("-")}-aa`;
  const source = JSON.parse(
    await readFile(resolve(root, "content/en.json"), "utf8"),
  );
  for (const [id, metadata] of Object.entries(source.seo.pages) as Array<
    [string, Record<string, unknown>]
  >) {
    metadata.path = `/${locale}/${id}/`;
  }
  await writeFile(
    resolve(root, `content/${locale}.json`),
    JSON.stringify(source),
  );

  await exec(process.execPath, [cli, "build", "--dir", resolve(root, "content")]);
  await access(resolve(root, `.seer/content/${locale}.json`));
});

test("CLI rejects noncanonical generated filenames before mutation", async (context) => {
  const cases = [
    ["locale JSON", ".seer/content/en.json", ".seer/content/EN.json"],
    ["robots", "public/robots.txt", "public/ROBOTS.TXT"],
    ["sitemap", "public/sitemap.xml", "public/SITEMAP.XML"],
  ] as const;

  for (const [name, canonicalName, aliasName] of cases) {
    await context.test(name, async (nested) => {
      const root = await fixture(nested);
      await exec(process.execPath, [cli, "build", "--dir", resolve(root, "content")]);
      const canonical = resolve(root, canonicalName);
      const alias = resolve(root, aliasName);
      const original = await readFile(canonical, "utf8");
      await rename(canonical, alias);
      await writeFile(resolve(root, ".seer/content/stale.json"), "{}\n");

      await assert.rejects(
        exec(process.execPath, [cli, "build", "--dir", resolve(root, "content")]),
        /filename is not canonical/,
      );
      assert.equal(await readFile(alias, "utf8"), original);
      await access(resolve(root, ".seer/content/stale.json"));
    });
  }
});

test("CLI rejects noncanonical output directories before mutation", async (context) => {
  for (const [name, canonicalName, aliasName, staleName] of [
    ["data", ".seer", ".SEER", ".SEER/content/stale.json"],
    ["public", "public", "PUBLIC", ".seer/content/stale.json"],
  ] as const) {
    await context.test(name, async (nested) => {
      const root = await fixture(nested);
      await exec(process.execPath, [cli, "build", "--dir", resolve(root, "content")]);
      await writeFile(resolve(root, ".seer/content/stale.json"), "{}\n");
      await rename(resolve(root, canonicalName), resolve(root, aliasName));

      await assert.rejects(
        exec(process.execPath, [cli, "build", "--dir", resolve(root, "content")]),
        /output path is not canonical/,
      );
      await access(resolve(root, aliasName));
      await access(resolve(root, staleName));
    });
  }
});

test("CLI rejects invalid arguments and output symlinks", async (context) => {
  for (const args of [[], ["unknown"], ["check", "extra"], ["check", "--wat"]]) {
    await assert.rejects(
      exec(process.execPath, [cli, ...args]),
      /usage: seer|Unknown option/,
    );
  }

  const root = await fixture(context);
  const outside = await mkdtemp(resolve(tmpdir(), "seer-outside-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(resolve(root, "public"), "not a directory");
  await assert.rejects(
    exec(process.execPath, [cli, "build", "--dir", resolve(root, "content")]),
    /not a real directory/,
  );
  await rm(resolve(root, "public"));
  await symlink(outside, resolve(root, "public"));
  await assert.rejects(
    exec(process.execPath, [cli, "build", "--dir", resolve(root, "content")]),
    /not canonical/,
  );
  await assert.rejects(access(resolve(outside, "robots.txt")));

  await rm(resolve(root, "public"));
  await exec(process.execPath, [cli, "build", "--dir", resolve(root, "content")]);
  await rename(
    resolve(root, ".seer/content/en.json"),
    resolve(root, ".seer/content/old.json"),
  );
  await symlink(outside, resolve(root, ".seer/content/en.json"));
  await assert.rejects(
    exec(process.execPath, [cli, "build", "--dir", resolve(root, "content")]),
    /generated content contains a non-file/,
  );
  assert.equal(await readFile(resolve(root, ".seer/content/old.json"), "utf8").then(Boolean), true);
});
