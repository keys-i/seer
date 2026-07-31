import { lstat, opendir, readFile, realpath } from "node:fs/promises";
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
  validate?: (content: JsonObject, locale: string) => void | Promise<void>;
}

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_GENERATED_BYTES = 50 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_LOCALES = 256;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const WINDOWS_DEVICE_NAME =
  /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

function fail(message: string): never { throw new Error(message); }

function object(value: unknown, path: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
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

function validString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.isWellFormed();
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  path: string,
) {
  const result = value[key];
  if (!validString(result)) {
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
  if (!validString(result)) {
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
    result.some((item) => !validString(item))
  ) {
    fail(`${path}.${key} must be an array of non-empty strings`);
  }
  return result as string[];
}

function safeDirectory(value: string, path: string) {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  if (
    isAbsolute(normalized) ||
    !normalized ||
    Buffer.byteLength(normalized) > 512 ||
    parts.length > 32 ||
    parts.some(
      (part) =>
        !part ||
        Buffer.byteLength(part) > 255 ||
        part === "." ||
        part === ".." ||
        CONTROL_OR_FORMAT.test(part) ||
        /[<>:"|?*]|^ |[ .]$/.test(part) ||
        WINDOWS_DEVICE_NAME.test(part),
    )
  ) {
    fail(`${path} must be a subdirectory inside the project`);
  }
  return normalized;
}

function safeLocale(value: string) {
  if (
    Buffer.byteLength(`${value}.json`) > 255 ||
    !/^[A-Za-z0-9-]+$/.test(value) ||
    WINDOWS_DEVICE_NAME.test(value)
  ) {
    fail("unsafe locale name");
  }
  let canonical: string;
  try {
    canonical = Intl.getCanonicalLocales(value)[0] ?? "";
  } catch {
    fail(`invalid locale: ${value}`);
  }
  if (canonical !== value) fail(`locale must be canonical: ${value}`);
  return value;
}

function decodeUrl(value: string, path: string) {
  try {
    return decodeURI(value);
  } catch {
    fail(`${path} must contain valid URL encoding`);
  }
}

function safePagePath(value: string, path: string) {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\s"#<>?[\]\\^`{|}]/u.test(value) ||
    value.split("/").some((part) => part === "." || part === "..") ||
    CONTROL_OR_FORMAT.test(value)
  ) {
    fail(`${path} must be a safe root-relative URL path`);
  }
  const decoded = decodeUrl(value, path);
  if (CONTROL_OR_FORMAT.test(decoded)) {
    fail(`${path} must be a safe root-relative URL path`);
  }
  for (const match of value.matchAll(/%[0-9A-Fa-f]{2}/g)) {
    const escape = match[0];
    const character = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    if (
      escape !== escape.toUpperCase() ||
      /[A-Za-z0-9._~-]/.test(character) ||
      character === "/" ||
      character === "\\"
    ) {
      fail(`${path} must use canonical URL encoding`);
    }
  }
  return value;
}

function safeRobotPath(value: string, path: string) {
  if (
    !value.startsWith("/") ||
    /[\u0000-\u0020\u007f#]/.test(value) ||
    !value.isWellFormed()
  ) {
    fail(`${path} must be a valid robots path pattern`);
  }
  decodeUrl(value, path);
  return value;
}

function safeUrl(value: string, path: string, base?: string) {
  if (CONTROL_OR_FORMAT.test(value)) fail(`${path} contains unsafe URL controls`);
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    fail(`${path} must be a valid URL`);
  }
  if (url.protocol !== "https:") fail(`${path} must use HTTPS`);
  if (url.username || url.password) fail(`${path} must not contain credentials`);
  const decoded = decodeUrl(url.href, path);
  if (CONTROL_OR_FORMAT.test(decoded)) fail(`${path} contains unsafe URL controls`);
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
  const base = new URL(siteUrl);
  safePagePath(base.pathname, "config.site.url");
  if (base.search || base.hash || !base.pathname.endsWith("/")) {
    fail("config.site.url must be an HTTPS base URL ending in / without credentials, query, or fragment");
  }

  const output = raw.output === undefined
    ? Object.create(null)
    : object(raw.output, "config.output");
  allowedKeys(output, ["public_dir"], "config.output");

  const robots = raw.robots === undefined
    ? Object.create(null)
    : object(raw.robots, "config.robots");
  allowedKeys(
    robots,
    ["disallow", "block_agents"],
    "config.robots",
  );
  const disallow = stringList(robots, "disallow", "config.robots").map(
    (path) => safeRobotPath(path, "config.robots.disallow"),
  );
  const blockAgents: string[] = [];
  const seenAgents = new Set<string>();
  for (const value of stringList(robots, "block_agents", "config.robots")) {
    if (!/^[A-Za-z_-]+$/.test(value)) {
      fail("config.robots.block_agents contains an invalid crawler token");
    }
    const key = value.toLowerCase();
    if (!seenAgents.has(key)) {
      seenAgents.add(key);
      blockAgents.push(value);
    }
  }

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
    robots: {
      disallow: [...new Set(disallow)],
      blockAgents,
    },
  };
}

function assertJson(
  value: unknown,
  path: string,
  depth = 0,
  ancestors = new WeakSet<object>(),
): asserts value is Json {
  if (depth > MAX_JSON_DEPTH) {
    fail(`${path} exceeds the maximum depth of ${MAX_JSON_DEPTH}`);
  }
  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) fail(`${path} contains invalid Unicode`);
    return;
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      fail(`${path} contains a number that JSON cannot preserve`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail(`${path} has an invalid array structure`);
    }
    if (ancestors.has(value)) fail(`${path} contains a circular reference`);
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail(`${path} has an invalid array structure`);
      assertJson(value[index], `${path}[${index}]`, depth + 1, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (!value || typeof value !== "object") fail(`${path} is not valid JSON`);
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${path} has an invalid object prototype`);
  }
  if (ancestors.has(value)) fail(`${path} contains a circular reference`);
  ancestors.add(value);
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (!key.isWellFormed() || CONTROL_OR_FORMAT.test(key)) {
      fail(`${path} contains an invalid JSON key`);
    }
    if (BLOCKED_KEYS.has(key)) fail(`${path}.${key} is forbidden`);
    assertJson(
      (value as Record<string, unknown>)[key],
      `${path}.${key}`,
      depth + 1,
      ancestors,
    );
  }
  ancestors.delete(value);
}

function validatedBytes(value: unknown, path: string) {
  assertJson(value, path);
  return Buffer.byteLength(JSON.stringify(value)) + 1;
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
    for (const key in localized) {
      if (!Object.hasOwn(localized, key)) continue;
      const value = localized[key]!;
      result[key] = Object.hasOwn(shared, key)
        ? merge(shared[key] as Json, value)
        : value;
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
  const expected = reference as JsonObject;
  const actual = candidate as JsonObject;
  let expectedCount = 0;
  for (const key in expected) {
    if (!Object.hasOwn(expected, key)) continue;
    expectedCount += 1;
    if (!Object.hasOwn(actual, key)) fail(`${locale}.json differs at ${path}`);
    compareShape(
      expected[key]!,
      actual[key]!,
      `${path}.${key}`,
      locale,
    );
  }
  let actualCount = 0;
  for (const key in actual) {
    if (Object.hasOwn(actual, key)) actualCount += 1;
  }
  if (expectedCount !== actualCount) fail(`${locale}.json differs at ${path}`);
}

async function textFile(path: string, limit: number) {
  const status = await lstat(path);
  if (!status.isFile()) {
    fail(`${path} must be a regular file`);
  }
  if ((await realpath(path)).normalize("NFC") !== path.normalize("NFC"))
    fail(`${path} must use its canonical filename`);
  if (status.size > limit) fail(`${path} exceeds its byte limit`);
  const data = await readFile(path);
  const bytes = data.byteLength;
  if (bytes > limit) fail(`${path} exceeds its byte limit`);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    fail(`${path} must be valid UTF-8`);
  }
  return { source, bytes };
}

function assertJsonSourceDepth(source: string, path: string) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (character === 0x5c) escaped = true;
      else if (character === 0x22) inString = false;
    } else if (character === 0x22) {
      inString = true;
    } else if (character === 0x5b || character === 0x7b) {
      depth += 1;
      if (depth > MAX_JSON_DEPTH + 1) {
        fail(`${path} exceeds the maximum depth of ${MAX_JSON_DEPTH}`);
      }
    } else if (character === 0x5d || character === 0x7d) {
      depth -= 1;
    }
  }
}

async function jsonFile(path: string) {
  const { source, bytes } = await textFile(path, MAX_FILE_BYTES);
  assertJsonSourceDepth(source, path);
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

  for (const id in pages) {
    if (!Object.hasOwn(pages, id)) continue;
    const value = pages[id];
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

    const pagePath = safePagePath(
      requiredString(page, "path", `${locale}.seo.pages.${id}`),
      `${locale}.seo.pages.${id}.path`,
    );
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
  const requestedContentDir = resolve(
    options.dir instanceof URL ? fileURLToPath(options.dir) : options.dir ?? "content",
  );
  if (!(await lstat(requestedContentDir)).isDirectory()) {
    fail(`${requestedContentDir} must be a real directory`);
  }
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
  const locales: string[] = [];
  for await (const entry of await opendir(contentDir)) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) {
      fail(`${resolve(contentDir, entry.name)} must be a regular file`);
    }
    if (entry.name !== "shared.json") {
      locales.push(safeLocale(entry.name.slice(0, -5)));
      if (locales.length > MAX_LOCALES) {
        fail(`content exceeds ${MAX_LOCALES} locales`);
      }
    }
  }
  locales.sort();
  if (locales.length === 0) fail("content must contain at least one locale JSON file");
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
    if (locale === config.defaultLocale) continue;
    compareShape(reference, localized[locale]!, "$", locale);
  }

  const content: Record<string, JsonObject> = {};
  let generatedBytes = 0;
  for (const locale of locales) {
    const value = structuredClone(
      merge(shared, localized[locale]!),
    ) as JsonObject;
    await options.validate?.(value, locale);
    generatedBytes += validatedBytes(value, `${locale}.validated`);
    if (generatedBytes > MAX_GENERATED_BYTES) {
      fail("generated content exceeds the 50 MiB limit");
    }
    content[locale] = value;
  }
  generatedBytes = 0;
  for (const locale of locales) {
    const value = content[locale]!;
    generatedBytes += validatedBytes(value, `${locale}.validated`);
    if (generatedBytes > MAX_GENERATED_BYTES) {
      fail("generated content exceeds the 50 MiB limit");
    }
  }
  const validatedReference = content[config.defaultLocale]!;
  for (const locale of locales) {
    if (locale === config.defaultLocale) continue;
    compareShape(validatedReference, content[locale]!, "$", locale);
  }
  const pages = Object.fromEntries(
    locales.map((locale) => [
      locale,
      pagesFor(content[locale]!, locale, config),
    ]),
  ) as Record<string, Record<string, PageSeo>>;

  const defaultPages = pages[config.defaultLocale]!;
  const seenUrls = new Set<string>();
  for (const locale of locales) {
    const localizedPages = pages[locale]!;
    for (const pageId in localizedPages) {
      if (!Object.hasOwn(localizedPages, pageId)) continue;
      const page = localizedPages[pageId]!;
      const url = new URL(`.${page.path}`, config.site.url).href;
      if (seenUrls.has(url)) fail(`duplicate canonical URL: ${url}`);
      seenUrls.add(url);
    }
    for (const pageId in defaultPages) {
      if (!Object.hasOwn(defaultPages, pageId)) continue;
      if (
        localizedPages[pageId]!.noindex !==
        defaultPages[pageId]!.noindex
      ) {
        fail(`${pageId}.noindex must match across locales`);
      }
    }
  }

  return { root, config, locales, content, pages };
}
