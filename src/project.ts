import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | JsonObject;

export interface JsonObject {
  [key: string]: Json;
}

export interface SeerConfig {
  defaultLocale: string;
  site: {
    name: string;
    url: string;
  };
  output: {
    publicDir: string;
  };
  robots: {
    disallow: string[];
    blockAgents: string[];
  };
}

export interface PageSeo {
  path: string;
  title: string;
  description: string;
  image?: string;
  imageAlt?: string;
  noindex: boolean;
}

export interface Project {
  root: string;
  config: SeerConfig;
  locales: string[];
  content: Record<string, JsonObject>;
  pages: Record<string, Record<string, PageSeo>>;
}

export interface ReadProjectOptions {
  dir?: string | URL;
  validate?: (content: JsonObject, locale: string) => void;
}

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_LOCALES = 256;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function fail(message: string): never { throw new Error(message); }

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function allowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key} is not supported`);
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  path: string,
) {
  const result = value[key];
  if (typeof result !== "string" || !result.trim()) {
    fail(`${path}.${key} must be a non-empty string`);
  }
  return result;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
) {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string" || !result.trim()) {
    fail(`${path}.${key} must be a non-empty string`);
  }
  return result;
}

function optionalBoolean(
  value: Record<string, unknown>,
  key: string,
  path: string,
) {
  const result = value[key];
  if (result === undefined) return false;
  if (typeof result !== "boolean") fail(`${path}.${key} must be boolean`);
  return result;
}

function stringList(
  value: Record<string, unknown>,
  key: string,
  path: string,
) {
  const result = value[key];
  if (result === undefined) return [];
  if (
    !Array.isArray(result) ||
    result.some((item) => typeof item !== "string" || !item.trim())
  ) {
    fail(`${path}.${key} must be an array of non-empty strings`);
  }
  return result as string[];
}

function safeDirectory(value: string, path: string) {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  if (
    isAbsolute(value) ||
    value.includes("\0") ||
    value.split(/[\\/]/).includes("..") ||
    !normalized ||
    normalized === "."
  ) {
    fail(`${path} must be a subdirectory inside the project`);
  }
  return normalized;
}

function safeLocale(value: string) {
  if (!/^[A-Za-z0-9-]+$/.test(value)) fail(`unsafe locale name: ${value}`);
  let canonical: string;
  try {
    canonical = Intl.getCanonicalLocales(value)[0] ?? "";
  } catch {
    fail(`invalid locale: ${value}`);
  }
  if (canonical !== value) fail(`locale must be canonical: ${value}`);
  return value;
}

function safePath(value: string, path: string) {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.split("/").includes("..") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${path} must be a safe root-relative URL path`);
  }
  return value;
}

function safeAgent(value: string, path: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    fail(`${path} contains an invalid crawler token: ${value}`);
  return value;
}

function safeUrl(value: string, path: string, base?: string) {
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    fail(`${path} must be a valid URL`);
  }
  if (url.protocol !== "https:") fail(`${path} must use HTTPS`);
  if (url.username || url.password) fail(`${path} must not contain credentials`);
  return url.href;
}

function contains(parent: string, child: string) {
  const path = relative(
    parent.normalize("NFC").toLowerCase(),
    child.normalize("NFC").toLowerCase(),
  );
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

const overlaps = (left: string, right: string) =>
  contains(left, right) || contains(right, left);

function parseConfig(source: string): SeerConfig {
  const raw = object(parse(source), "config");
  allowedKeys(
    raw,
    [
      "version",
      "default_locale",
      "site",
      "output",
      "robots",
    ],
    "config",
  );
  if (raw.version !== 1) fail("config.version must be 1");

  const defaultLocale = safeLocale(
    requiredString(raw, "default_locale", "config"),
  );
  const site = object(raw.site, "config.site");
  allowedKeys(site, ["name", "url"], "config.site");
  const siteUrl = safeUrl(requiredString(site, "url", "config.site"), "site.url");
  const origin = new URL(siteUrl);
  if (origin.href !== `${origin.origin}/`) {
    fail("config.site.url must be an HTTPS origin without credentials, path, query, or fragment");
  }

  const output = raw.output
    ? object(raw.output, "config.output")
    : Object.create(null);
  allowedKeys(output, ["public_dir"], "config.output");

  const robots = raw.robots
    ? object(raw.robots, "config.robots")
    : Object.create(null);
  allowedKeys(
    robots,
    ["disallow", "block_agents"],
    "config.robots",
  );
  const disallow = stringList(robots, "disallow", "config.robots").map(
    (path) => safePath(path, "config.robots.disallow"),
  );
  const blockAgents = stringList(
    robots,
    "block_agents",
    "config.robots",
  ).map((agent) => safeAgent(agent, "config.robots.block_agents"));

  return {
    defaultLocale,
    site: {
      name: requiredString(site, "name", "config.site"),
      url: siteUrl,
    },
    output: {
      publicDir: safeDirectory(
        optionalString(output, "public_dir", "config.output") ?? "public",
        "config.output.public_dir",
      ),
    },
    robots: { disallow, blockAgents },
  };
}

function assertJson(value: unknown, path: string, depth = 0): asserts value is Json {
  if (depth > 64) fail(`${path} exceeds the maximum depth of 64`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") fail(`${path} is not valid JSON`);
  for (const [key, item] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(key)) fail(`${path}.${key} is forbidden`);
    assertJson(item, `${path}.${key}`, depth + 1);
  }
}

function merge(shared: Json, localized: Json): Json {
  if (
    shared &&
    localized &&
    typeof shared === "object" &&
    typeof localized === "object" &&
    !Array.isArray(shared) &&
    !Array.isArray(localized)
  ) {
    const result: JsonObject = { ...shared };
    for (const [key, value] of Object.entries(localized)) {
      result[key] = key in shared ? merge(shared[key] as Json, value) : value;
    }
    return result;
  }
  return localized;
}

function compareShape(reference: Json, candidate: Json, path: string, locale: string) {
  const type = Array.isArray(reference)
    ? "array"
    : reference === null
      ? "null"
      : typeof reference;
  const candidateType = Array.isArray(candidate)
    ? "array"
    : candidate === null
      ? "null"
      : typeof candidate;
  if (type !== candidateType) fail(`${locale}.json differs at ${path}`);
  if (type === "array") {
    const expected = reference as Json[];
    const actual = candidate as Json[];
    if (expected.length !== actual.length) fail(`${locale}.json differs at ${path}`);
    expected.forEach((value, index) =>
      compareShape(value, actual[index]!, `${path}[${index}]`, locale),
    );
    return;
  }
  if (type !== "object") return;
  const expected = Object.keys(reference as JsonObject).sort();
  const actual = Object.keys(candidate as JsonObject).sort();
  if (expected.join("\0") !== actual.join("\0")) {
    fail(`${locale}.json differs at ${path}`);
  }
  for (const key of expected) {
    compareShape(
      (reference as JsonObject)[key]!,
      (candidate as JsonObject)[key]!,
      `${path}.${key}`,
      locale,
    );
  }
}

async function textFile(path: string, limit: number) {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    fail(`${path} must be a regular file`);
  }
  if (status.size > limit) fail(`${path} exceeds its byte limit`);
  const source = await readFile(path, "utf8");
  const bytes = Buffer.byteLength(source);
  if (bytes > limit) fail(`${path} exceeds its byte limit`);
  return { source, bytes };
}

async function jsonFile(path: string) {
  const { source, bytes } = await textFile(path, MAX_FILE_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail(`${path} is invalid JSON: ${(error as Error).message}`);
  }
  assertJson(value, path);
  return { value: object(value, path) as JsonObject, bytes };
}

function pagesFor(
  content: JsonObject,
  locale: string,
  config: SeerConfig,
) {
  const seo = object(content.seo, `${locale}.seo`);
  const pages = object(seo.pages, `${locale}.seo.pages`);
  const result: Record<string, PageSeo> = {};
  const seenPaths = new Set<string>();

  for (const [id, value] of Object.entries(pages)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) fail(`unsafe page id: ${id}`);
    const page = object(value, `${locale}.seo.pages.${id}`);
    allowedKeys(
      page,
      [
        "path",
        "title",
        "description",
        "image",
        "image_alt",
        "noindex",
      ],
      `${locale}.seo.pages.${id}`,
    );

    const pagePath = safePath(
      requiredString(page, "path", `${locale}.seo.pages.${id}`),
      `${locale}.seo.pages.${id}.path`,
    );
    if (seenPaths.has(pagePath)) fail(`${locale} has duplicate path: ${pagePath}`);
    seenPaths.add(pagePath);

    const title = requiredString(page, "title", `${locale}.seo.pages.${id}`);
    const description = requiredString(
      page,
      "description",
      `${locale}.seo.pages.${id}`,
    );
    const image = optionalString(page, "image", `${locale}.seo.pages.${id}`);
    const imageAlt = optionalString(
      page,
      "image_alt",
      `${locale}.seo.pages.${id}`,
    );
    if (Boolean(image) !== Boolean(imageAlt)) {
      fail(`${locale}.${id} image and image_alt must be set together`);
    }
    if (image) safeUrl(image, `${locale}.${id}.image`, config.site.url);

    result[id] = {
      path: pagePath,
      title,
      description,
      noindex: optionalBoolean(
        page,
        "noindex",
        `${locale}.seo.pages.${id}`,
      ),
      ...(image && imageAlt ? { image, imageAlt } : {}),
    };
  }
  return result;
}

export async function readProject(
  options: ReadProjectOptions = {},
): Promise<Project> {
  const requestedContentDir =
    options.dir instanceof URL
      ? fileURLToPath(options.dir)
      : resolve(options.dir ?? "content");
  const contentDir = await realpath(requestedContentDir);
  const root = dirname(contentDir);
  const configSource = await textFile(
    resolve(contentDir, "config.toml"),
    MAX_CONFIG_BYTES,
  );
  const config = parseConfig(configSource.source);
  const dataDir = resolve(root, ".seer");
  const publicDir = resolve(root, config.output.publicDir);
  if (
    overlaps(contentDir, dataDir) ||
    overlaps(contentDir, publicDir) ||
    overlaps(dataDir, publicDir)
  ) {
    fail("input and output directories must not overlap");
  }
  const entries = await readdir(contentDir, { withFileTypes: true });
  const locales = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        entry.name !== "shared.json",
    )
    .map((entry) => safeLocale(entry.name.slice(0, -5)))
    .sort();
  if (locales.length === 0) fail("content must contain at least one locale JSON file");
  if (locales.length > MAX_LOCALES) fail(`content exceeds ${MAX_LOCALES} locales`);
  if (!locales.includes(config.defaultLocale)) {
    fail(`missing default locale file: ${config.defaultLocale}.json`);
  }

  const sharedFile = await jsonFile(resolve(contentDir, "shared.json"));
  let totalBytes = sharedFile.bytes;
  const localized: Record<string, JsonObject> = {};
  for (const locale of locales) {
    const file = await jsonFile(resolve(contentDir, `${locale}.json`));
    totalBytes += file.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      fail("JSON content exceeds the 25 MiB aggregate limit");
    }
    localized[locale] = file.value;
  }
  const shared = sharedFile.value;
  const reference = localized[config.defaultLocale]!;
  for (const locale of locales) {
    compareShape(reference, localized[locale]!, "$", locale);
  }

  const content = Object.fromEntries(
    locales.map((locale) => {
      const value = merge(shared, localized[locale]!) as JsonObject;
      options.validate?.(value, locale);
      return [locale, value];
    }),
  ) as Record<string, JsonObject>;
  const pages = Object.fromEntries(
    locales.map((locale) => [
      locale,
      pagesFor(content[locale]!, locale, config),
    ]),
  ) as Record<string, Record<string, PageSeo>>;

  const pageIds = Object.keys(pages[config.defaultLocale] ?? {}).sort();
  const seenUrls = new Set<string>();
  for (const locale of locales) {
    const ids = Object.keys(pages[locale] ?? {}).sort();
    if (ids.join("\0") !== pageIds.join("\0")) {
      fail(`${locale} does not define the same page IDs as the default locale`);
    }
    for (const page of Object.values(pages[locale]!)) {
      const url = new URL(page.path, config.site.url).href;
      if (seenUrls.has(url)) fail(`duplicate canonical URL: ${url}`);
      seenUrls.add(url);
    }
    for (const pageId of pageIds) {
      if (
        pages[locale]![pageId]!.noindex !==
        pages[config.defaultLocale]![pageId]!.noindex
      ) {
        fail(`${pageId}.noindex must match across locales`);
      }
    }
  }

  return { root, config, locales, content, pages };
}
