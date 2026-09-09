import {
  cp,
  lstat,
  mkdir,
  opendir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import {
  parse,
  parseFragment,
  serialize,
  serializeOuter,
  type DefaultTreeAdapterMap as Tree,
} from "parse5";
import { atomicWrite, outside, safeMkdir } from "./files.js";
import {
  pageUrl,
  parseConfig,
  safeDirectory,
  textFile,
  type Project,
  type SeerConfig,
} from "./project.js";
import { headData, robotsTxt, serializeJsonLd, sitemapXml } from "./seo.js";
import {
  checkTranslation,
  translateMessages,
  type Message,
} from "./translate.js";

type Element = Tree["element"];
type Node = Tree["node"];
type Unit = {
  id: string;
  source: string;
  context: string;
  apply(value: string): void;
};
type Catalog = {
  version: 1;
  source_locale: string;
  locale: string;
  messages: Record<string, Message>;
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
const attr = (node: Element, name: string) =>
  node.attrs.find((item) => item.name === name)?.value;
function setAttr(node: Element, name: string, value: string) {
  const existing = node.attrs.find((item) => item.name === name);
  if (existing) existing.value = value;
  else node.attrs.push({ name, value });
}
function* elements(node: Node): Generator<Element> {
  if ("tagName" in node) yield node;
  if ("childNodes" in node)
    for (const child of node.childNodes) yield* elements(child);
}
const protectedTags = new Set([
  "code",
  "pre",
  "script",
  "style",
  "svg",
  "math",
  "textarea",
  "noscript",
  "template",
]);
const blockTags = new Set([
  "div",
  "p",
  "ul",
  "ol",
  "li",
  "dl",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "form",
  "details",
  "blockquote",
  "figure",
]);
const groupTags = new Set([
  "title",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "a",
  "button",
  "label",
  "summary",
  "th",
  "td",
  "dt",
  "dd",
  "figcaption",
]);
const voidTags = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function protectedElement(node: Element, sourceLocale: string): boolean {
  if (
    protectedTags.has(node.tagName) ||
    attr(node, "translate")?.toLowerCase() === "no" ||
    /(?:^|\s)(?:notranslate|arithmatex|mermaid)(?:\s|$)/u.test(
      attr(node, "class") ?? "",
    )
  ) return true;
  const language = attr(node, "lang");
  if (!language) return false;
  try {
    return new Intl.Locale(language).language !== new Intl.Locale(sourceLocale).language;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new Error(`invalid HTML language tag: ${JSON.stringify(language)}`, { cause: error });
  }
}

export function extractHtml(
  html: string,
  sourceLocale: string,
  preserve: string[] = [],
): { document: Tree["document"]; units: Unit[] } {
  const document = parse(html);
  const units: Unit[] = [];
  function add(
    source: string,
    context: string,
    apply: Unit["apply"],
    identity = "",
    inline = false,
  ) {
    if (!/\p{L}/u.test(source) || !source.trim()) return;
    if (!inline && /\{\{SEER_/u.test(source))
      throw new Error("source text uses Seer's reserved placeholder prefix");
    const protectedText: string[] = [];
    const terms = [...preserve]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const termPattern = terms.length
      ? new RegExp(
          `(?<![\\p{L}\\p{N}_])(?:${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})(?![\\p{L}\\p{N}_])`,
          "gu",
        )
      : null;
    const protect = (text: string) => {
      protectedText.push(text);
      return `{{SEER_TERM_${protectedText.length - 1}}}`;
    };
    let input = source.replace(/https?:\/\/[^\s<>]+/gu, protect);
    if (termPattern) input = input.replace(termPattern, protect);
    if (context === "interface") input = input.replaceAll("#", protect);
    input = input.replace(
      /(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+)*(?:[eE][-+]?\d+)?(?![\p{L}\p{N}_])/gu,
      protect,
    );
    if (!/\p{L}/u.test(input.replace(/\{\{SEER_(?:TERM|HTML)_\d+\}\}/gu, "")))
      return;
    const leading = source.match(/^\s*/u)![0];
    const trailing = source.match(/\s*$/u)![0];
    const normalized = input.replace(/\s+/gu, " ").trim();
    units.push({
      id: hash(
        `${context}\0${source.replace(/\s+/gu, " ").trim()}\0${identity}`,
      ),
      source: normalized,
      context,
      apply(value) {
        const restored = value.replace(
          /\{\{SEER_TERM_(\d+)\}\}/gu,
          (_, index) => protectedText[Number(index)]!,
        );
        apply(leading + restored.trim() + trailing);
      },
    });
  }
  function attributes(node: Node) {
    if ("tagName" in node) {
      if (protectedElement(node, sourceLocale)) return;
      for (const item of node.attrs) {
        if (
          ["alt", "title", "aria-label", "placeholder"].includes(item.name) ||
          (node.tagName === "meta" &&
            item.name === "content" &&
            [
              "description",
              "og:title",
              "og:description",
              "og:image:alt",
              "twitter:title",
              "twitter:description",
              "twitter:image:alt",
            ].includes(attr(node, "name") ?? attr(node, "property") ?? ""))
        ) {
          add(item.value, `${node.tagName}.${item.name}`, (value) => {
            item.value = value;
          });
        }
      }
    }
    if ("childNodes" in node)
      for (const child of node.childNodes) attributes(child);
  }
  attributes(document);
  for (const script of elements(document)) {
    if (
      script.tagName !== "script" ||
      !(
        attr(script, "type") === "application/ld+json" ||
        (attr(script, "id") === "__config" &&
          attr(script, "type") === "application/json")
      )
    )
      continue;
    const data: unknown = JSON.parse(
      script.childNodes
        .map((node) =>
          node.nodeName === "#text" ? (node as Tree["textNode"]).value : "",
        )
        .join(""),
    );
    const write = () => {
      script.childNodes = [
        {
          nodeName: "#text",
          value: JSON.stringify(data).replaceAll("<", "\\u003c"),
          parentNode: script,
        },
      ];
    };
    if (attr(script, "id") === "__config") {
      const translations = (data as { translations?: Record<string, unknown> })
        .translations;
      if (translations)
        for (const [key, value] of Object.entries(translations)) {
          if (typeof value === "string")
            add(value, "interface", (translated) => {
              translations[key] = translated;
              write();
            });
        }
      continue;
    }
    function schema(value: unknown) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(schema);
        return;
      }
      const record = value as Record<string, unknown>;
      if (["Person", "Organization"].includes(String(record["@type"]))) return;
      for (const [key, child] of Object.entries(record)) {
        if (
          ["name", "headline", "description", "abstract"].includes(key) &&
          typeof child === "string"
        ) {
          add(child, `jsonld.${key}`, (translated) => {
            record[key] = translated;
            write();
          });
        } else schema(child);
      }
    }
    schema(data);
  }
  function text(node: Node) {
    if ("tagName" in node) {
      if (protectedElement(node, sourceLocale)) return;
      const grouped =
        groupTags.has(node.tagName) &&
        !node.childNodes.some((child) =>
          [...elements(child)].some(
            (element) =>
              blockTags.has(element.tagName) &&
              !protectedElement(element, sourceLocale),
          ),
        );
      if (grouped) {
        const tokens: Array<{
          html: () => string;
          semantic: string;
          open?: number;
          close?: number;
        }> = [];
        const token = (value: (typeof tokens)[number]) => {
          tokens.push(value);
          return `{{SEER_HTML_${tokens.length - 1}}}`;
        };
        const flatten = (child: Node): string => {
          if (child.nodeName === "#text") {
            const value = (child as Tree["textNode"]).value;
            if (/\{\{SEER_/u.test(value))
              throw new Error("source text uses Seer's reserved placeholder prefix");
            return value;
          }
          if (!("tagName" in child))
            return token({
              html: () => serializeOuter(child),
              semantic: "comment",
            });
          if (
            protectedElement(child, sourceLocale) ||
            voidTags.has(child.tagName)
          ) {
            return token({
              html: () => serializeOuter(child),
              semantic: serializeOuter(child),
            });
          }
          const pair = tokens.length;
          const start = token({
            open: pair,
            semantic: `<${child.tagName}>`,
            html: () =>
              serializeOuter({ ...child, childNodes: [] }).slice(
                0,
                -`</${child.tagName}>`.length,
              ),
          });
          return (
            start +
            child.childNodes.map(flatten).join("") +
            token({
              close: pair,
              semantic: `</${child.tagName}>`,
              html: () => `</${child.tagName}>`,
            })
          );
        };
        const source = node.childNodes.map(flatten).join("");
        if (tokens.length) {
          add(
            source,
            node.tagName,
            (value) => {
              const stack: number[] = [];
              const rendered = escape(value).replace(
                /\{\{SEER_HTML_(\d+)\}\}/gu,
                (_, index) => {
                  const item = tokens[Number(index)]!;
                  if (item.open !== undefined) stack.push(item.open);
                  if (item.close !== undefined && stack.pop() !== item.close)
                    throw new Error(
                      "translation crossed inline HTML boundaries",
                    );
                  return item.html();
                },
              );
              if (stack.length)
                throw new Error("translation left an inline HTML element open");
              node.childNodes = parseFragment(node, rendered, {}).childNodes;
              for (const child of node.childNodes) child.parentNode = node;
            },
            tokens.map((item) => item.semantic).join("\0"),
            true,
          );
        } else
          add(source, node.tagName, (value) => {
            node.childNodes = [{ nodeName: "#text", value, parentNode: node }];
          });
        return;
      }
    }
    if (node.nodeName === "#text") {
      const current = node as Tree["textNode"];
      add(current.value, "text", (value) => {
        current.value = value;
      });
    } else if ("childNodes" in node)
      for (const child of node.childNodes) text(child);
  }
  text(document);
  return { document, units };
}

async function files(root: string): Promise<string[]> {
  if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root)
    throw new Error("site must be a real directory");
  const found: string[] = [];
  async function visit(directory: string) {
    for await (const entry of await opendir(directory)) {
      const path = resolve(directory, entry.name);
      safeDirectory(relative(root, path), "site file");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) found.push(path);
      else
        throw new Error(
          `site contains a symlink or non-regular file: ${entry.name}`,
        );
    }
  }
  await visit(root);
  return found.sort();
}

async function catalog(
  path: string,
  sourceLocale: string,
  locale: string,
  units: Map<string, Message>,
): Promise<Catalog> {
  let previous: Record<string, Message> = {};
  try {
    const { source } = await textFile(path, 25 * 1024 * 1024);
    const value = JSON.parse(source) as Catalog;
    if (
      value.version !== 1 ||
      value.source_locale !== sourceLocale ||
      value.locale !== locale ||
      !value.messages ||
      typeof value.messages !== "object" ||
      Array.isArray(value.messages)
    )
      throw new Error(`invalid catalog: ${path}`);
    previous = value.messages;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const messages = Object.fromEntries(
    [...units].map(([id, message]) => {
      const existing = Object.hasOwn(previous, id) ? previous[id] : undefined;
      if (
        existing?.source === message.source &&
        existing.context === message.context &&
        existing.translation !== undefined
      ) {
        if (typeof existing.translation !== "string")
          throw new Error(`invalid translation: ${locale}/${id}`);
        checkTranslation(
          message.source,
          existing.translation,
          sourceLocale,
          locale,
        );
        return [
          id,
          {
            ...message,
            translation: existing.translation,
            ...(typeof existing.provider === "string"
              ? { provider: existing.provider }
              : {}),
            ...(typeof existing.requestId === "string"
              ? { requestId: existing.requestId }
              : {}),
          },
        ];
      }
      return [id, { ...message }];
    }),
  );
  return { version: 1, source_locale: sourceLocale, locale, messages };
}

const routeFor = (path: string) =>
  "/" +
  path
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/(?:^|\/)index\.html$/u, "/")
    .replace(/^\//u, "");
const titleOf = (document: Node) => {
  const title = [...elements(document)].find(
    (node) => node.tagName === "title",
  );
  return title
    ? title.childNodes
        .map((node) =>
          node.nodeName === "#text" ? (node as Tree["textNode"]).value : "",
        )
        .join("")
    : "";
};

function localLinks(
  document: Node,
  sourceUrl: string,
  config: SeerConfig,
  locale: string,
  routes: Set<string>,
) {
  const base = new URL(config.site.url);
  const all = [...elements(document)];
  const existingBase = all.find(
    (node) => node.tagName === "base" && attr(node, "href") !== undefined,
  );
  const documentBase = new URL(
    existingBase ? attr(existingBase, "href")! : sourceUrl,
    sourceUrl,
  ).href;
  if (existingBase) setAttr(existingBase, "href", documentBase);
  else {
    const head = all.find((node) => node.tagName === "head")!;
    const element = parseFragment(`<base href="${escape(documentBase)}">`).childNodes[0]!;
    element.parentNode = head;
    head.childNodes.unshift(element);
  }
  for (const node of all)
    for (const attribute of node.attrs) {
      if (
        !["href", "src", "poster", "action"].includes(attribute.name) ||
        /^(?:data:|mailto:|tel:|javascript:)/iu.test(attribute.value)
      )
        continue;
      const url = new URL(attribute.value, documentBase);
      const path = ("/" + url.pathname.slice(base.pathname.length)).replace(/\/index\.html$/u, "/");
      if (
        url.origin === base.origin &&
        url.pathname.startsWith(base.pathname) &&
        node.tagName === "a" &&
        attribute.name === "href" &&
        routes.has(path)
      ) {
        attribute.value = pageUrl(config, locale, path) + url.search + url.hash;
      } else attribute.value = url.href;
    }
}

export async function localize(
  options: {
    dir?: string;
    extract?: boolean;
    translate?: boolean;
    key?: string;
    fetch?: typeof fetch;
  } = {},
) {
  if (options.extract && options.translate)
    throw new Error("choose either --extract or --translate");
  const requestedDir = resolve(options.dir ?? "locales");
  if (!(await lstat(requestedDir)).isDirectory())
    throw new Error("locale directory must be a real directory");
  const contentDir = await realpath(requestedDir);
  const root = dirname(contentDir);
  const config = parseConfig(
    (await textFile(resolve(contentDir, "config.toml"), 256 * 1024)).source,
  );
  const settings = config.localization;
  if (!settings)
    throw new Error("config.localization is required for HTML localization");
  const input = resolve(root, settings.sourceDir);
  const output = resolve(root, config.output.publicDir);
  const cacheDir = resolve(root, ".seer");
  const paths = [input, output, contentDir, cacheDir];
  for (let a = 0; a < paths.length; a++)
    for (let b = a + 1; b < paths.length; b++) {
      if (!outside(paths[a]!, paths[b]!) || !outside(paths[b]!, paths[a]!))
        throw new Error(
          "localization source, output, catalogs and .seer directories must not overlap",
        );
    }
  if (!(await lstat(input)).isDirectory() || (await realpath(input)) !== input)
    throw new Error("source site must be a real directory");
  const sourceFiles = await files(input);
  const localeDirectories = new Set(
    settings.locales.map((locale) => locale.toLowerCase()),
  );
  if (
    sourceFiles.some((path) =>
      localeDirectories.has(
        relative(input, path).split(/[\\/]/u)[0]!.toLowerCase(),
      ),
    )
  )
    throw new Error(
      "source site uses a directory reserved for a locale; use the original unlocalized build as source",
    );
  const pages: Array<{
    id: string;
    file: string;
    route: string;
    html: string;
  }> = [];
  const messages = new Map<string, Message>();
  const languageLabelId = hash("language-navigation");
  messages.set(languageLabelId, { source: "Languages", context: "navigation" });
  let sourceBytes = 0;
  for (const path of sourceFiles) {
    if (!path.endsWith(".html")) continue;
    const file = relative(input, path).replaceAll("\\", "/");
    const route = routeFor(file);
    if (
      settings.exclude.some(
        (excluded) =>
          route === excluded ||
          (excluded.endsWith("/") && route.startsWith(excluded)),
      )
    )
      continue;
    const html = (await textFile(path, 5 * 1024 * 1024)).source;
    sourceBytes += Buffer.byteLength(html);
    if (sourceBytes > 25 * 1024 * 1024)
      throw new Error("source HTML exceeds the 25 MiB aggregate limit");
    const parsed = extractHtml(html, config.defaultLocale, settings.preserve);
    if (
      [...elements(parsed.document)].some(
        (node) =>
          node.tagName === "meta" &&
          attr(node, "name")?.toLowerCase() === "robots" &&
          /\b(?:noindex|none)\b/iu.test(attr(node, "content") ?? ""),
      )
    )
      continue;
    pages.push({ id: "p" + hash(route), file, route, html });
    for (const unit of parsed.units)
      messages.set(unit.id, { source: unit.source, context: unit.context });
  }
  if (!pages.length)
    throw new Error("source site contains no indexable HTML pages");
  if (pages.length * settings.locales.length > 50_000)
    throw new Error("localized site exceeds 50,000 pages");
  const catalogs = new Map<string, Catalog>();
  for (const locale of settings.locales) {
    if (locale === config.defaultLocale) continue;
    const path = resolve(contentDir, `${locale}.json`);
    const value = await catalog(path, config.defaultLocale, locale, messages);
    catalogs.set(locale, value);
    const save = () => atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
    await save();
    if (options.translate)
      await translateMessages(value.messages, config.defaultLocale, locale, {
        key: options.key ?? process.env.SARVAM_API_KEY ?? "",
        ...(options.fetch ? { fetch: options.fetch } : {}),
        save,
      });
  }
  const missing = [...catalogs].map(([locale, value]) => ({
    locale,
    missing: Object.values(value.messages).filter(
      (message) => message.translation === undefined,
    ).length,
  }));
  const summary = {
    pages: pages.length,
    messages: messages.size,
    locales: settings.locales,
    missing,
  };
  await safeMkdir(root, cacheDir);
  await atomicWrite(
    resolve(cacheDir, "localization-report.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  if (options.extract) return summary;
  if (missing.some((value) => value.missing))
    throw new Error(
      `translations needed: ${missing
        .filter((value) => value.missing)
        .map((value) => `${value.locale} (${value.missing})`)
        .join(", ")}; edit the catalogs or run seer localize --translate`,
    );
  const project: Project = {
    root,
    config,
    locales: settings.locales,
    pages: {},
    content: {},
  };
  const rendered = new Map<
    string,
    {
      document: Tree["document"];
      route: string;
      file: string;
      locale: string;
      pageId: string;
    }
  >();
  const routes = new Set(pages.map((page) => page.route));
  for (const locale of settings.locales) {
    project.pages[locale] = {};
    for (const page of pages) {
      const parsed = extractHtml(
        page.html,
        config.defaultLocale,
        settings.preserve,
      );
      if (locale !== config.defaultLocale)
        for (const unit of parsed.units) {
          const translation =
            catalogs.get(locale)!.messages[unit.id]!.translation!;
          checkTranslation(
            unit.source,
            translation,
            config.defaultLocale,
            locale,
          );
          unit.apply(translation);
        }
      const description = [...elements(parsed.document)].find(
        (node) =>
          node.tagName === "meta" && attr(node, "name") === "description",
      );
      project.pages[locale]![page.id] = {
        path: page.route,
        title: titleOf(parsed.document),
        description: description
          ? attr(description, "content")!
          : titleOf(parsed.document),
        noindex: false,
      };
      localLinks(
        parsed.document,
        new URL(`.${page.route}`, config.site.url).href,
        config,
        locale,
        routes,
      );
      rendered.set(`${locale}/${page.file}`, {
        document: parsed.document,
        route: page.route,
        file: page.file,
        locale,
        pageId: page.id,
      });
    }
  }
  for (const value of rendered.values()) {
    const metadata = headData(project, value.locale, value.pageId);
    const all = [...elements(value.document)];
    const html = all.find((node) => node.tagName === "html")!;
    const head = all.find((node) => node.tagName === "head")!;
    const body = all.find((node) => node.tagName === "body")!;
    setAttr(html, "lang", metadata.lang);
    setAttr(html, "dir", metadata.dir);
    head.childNodes = head.childNodes.filter(
      (node) =>
        !("tagName" in node) ||
        !(
          (node.tagName === "link" &&
            (attr(node, "rel") === "canonical" ||
              (attr(node, "rel") === "alternate" && attr(node, "hreflang")))) ||
          (node.tagName === "meta" &&
            [
              "og:url",
              "og:title",
              "og:description",
              "og:locale",
              "og:locale:alternate",
              "twitter:title",
              "twitter:description",
            ].includes(attr(node, "property") ?? attr(node, "name") ?? ""))
        ),
    );
    const links = Object.entries(metadata.alternates)
      .map(
        ([locale, url]) =>
          `<link rel="alternate" hreflang="${escape(locale)}" href="${escape(url)}">`,
      )
      .join("");
    let hasSchema = false;
    const sourceUrl = new URL(`.${value.route}`, config.site.url).href;
    for (const script of all.filter(
      (node) =>
        node.tagName === "script" &&
        attr(node, "type") === "application/ld+json",
    )) {
      const data: unknown = JSON.parse(
        script.childNodes
          .map((node) =>
            node.nodeName === "#text" ? (node as Tree["textNode"]).value : "",
          )
          .join(""),
      );
      const update = (entry: unknown) => {
        if (!entry || typeof entry !== "object") return;
        if (Array.isArray(entry)) {
          entry.forEach(update);
          return;
        }
        for (const [key, child] of Object.entries(entry)) {
          const record = entry as Record<string, unknown>;
          if (key === "inLanguage") record[key] = value.locale;
          else if (
            (key === "url" || key === "@id") &&
            typeof child === "string" &&
            (child === sourceUrl || child.startsWith(sourceUrl + "#"))
          )
            record[key] = metadata.canonical + child.slice(sourceUrl.length);
          else update(child);
        }
      };
      update(data);
      script.childNodes = [
        {
          nodeName: "#text",
          value: JSON.stringify(data).replaceAll("<", "\\u003c"),
          parentNode: script,
        },
      ];
      hasSchema = true;
    }
    const locale = new Intl.Locale(value.locale).maximize();
    const tags = `<link rel="canonical" href="${escape(metadata.canonical)}">${links}<meta property="og:url" content="${escape(metadata.canonical)}"><meta property="og:title" content="${escape(metadata.title)}"><meta property="og:description" content="${escape(metadata.description)}"><meta name="twitter:title" content="${escape(metadata.title)}"><meta name="twitter:description" content="${escape(metadata.description)}"><meta property="og:locale" content="${escape(`${locale.language}_${locale.region}`)}">${hasSchema ? "" : `<script type="application/ld+json">${serializeJsonLd(metadata.jsonLd)}</script>`}`;
    const additions = parseFragment(tags).childNodes;
    for (const node of additions) node.parentNode = head;
    head.childNodes.push(...additions);
    for (const script of all.filter(
      (node) =>
        node.tagName === "script" &&
        attr(node, "id") === "__config" &&
        attr(node, "type") === "application/json",
    )) {
      const data = JSON.parse(
        script.childNodes
          .map((node) =>
            node.nodeName === "#text" ? (node as Tree["textNode"]).value : "",
          )
          .join(""),
      );
      data.base = config.site.url;
      script.childNodes = [
        {
          nodeName: "#text",
          value: JSON.stringify(data).replaceAll("<", "\\u003c"),
          parentNode: script,
        },
      ];
    }
    const languageLabel =
      value.locale === config.defaultLocale
        ? "Languages"
        : catalogs.get(value.locale)!.messages[languageLabelId]!.translation!;
    const currentLanguage =
      new Intl.DisplayNames([value.locale], { type: "language" }).of(
        value.locale,
      ) ?? value.locale;
    const navigation = parseFragment(
      `<details translate="no" style="padding:0.5rem 1rem;font:inherit"><summary style="cursor:pointer">🌐 ${escape(currentLanguage)}</summary><nav aria-label="${escape(languageLabel)}" style="display:flex;flex-wrap:wrap;gap:0.5rem 1rem;padding-block:0.5rem">${settings.locales.map((locale) => `<a lang="${locale}" hreflang="${locale}" href="${escape(pageUrl(config, locale, value.route))}"${locale === value.locale ? ' aria-current="page"' : ""}>${escape(new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale)}</a>`).join("")}</nav></details>`,
    ).childNodes;
    for (const node of navigation) node.parentNode = body;
    body.childNodes.unshift(...navigation);
  }
  const staging = resolve(cacheDir, `site-${randomUUID()}`);
  await mkdir(staging);
  try {
    const translatedFiles = new Set(pages.map((page) => page.file));
    for (const path of sourceFiles) {
      const sourceFile = relative(input, path).replaceAll("\\", "/");
      const destination = resolve(staging, sourceFile);
      await safeMkdir(root, dirname(destination));
      await cp(path, destination, { dereference: false });
      if (
        config.routing?.strategy === "subdomain" &&
        path.endsWith(".html") &&
        !translatedFiles.has(sourceFile)
      ) {
        const { source } = await textFile(path, 5 * 1024 * 1024);
        for (const locale of settings.locales) {
          const document = parse(source);
          localLinks(document, new URL(`.${routeFor(sourceFile)}`, config.site.url).href, config, locale, routes);
          const file = resolve(staging, locale.toLowerCase(), sourceFile);
          await safeMkdir(root, dirname(file));
          await atomicWrite(file, serialize(document));
        }
      }
    }
    for (const value of rendered.values()) {
      const file = resolve(staging, value.locale.toLowerCase(), value.file);
      await safeMkdir(root, dirname(file));
      const html = serialize(value.document);
      await atomicWrite(file, html);
      if (value.locale === config.defaultLocale)
        await atomicWrite(resolve(staging, value.file), html);
    }
    await atomicWrite(resolve(staging, "sitemap.xml"), sitemapXml(project));
    await atomicWrite(resolve(staging, "robots.txt"), robotsTxt(project));
    if (sourceFiles.includes(resolve(input, "search/search_index.json"))) {
      const search = JSON.parse(
        (
          await textFile(
            resolve(input, "search/search_index.json"),
            25 * 1024 * 1024,
          )
        ).source,
      );
      search.docs = [...rendered.values()].map((value) => {
        const content =
          [...elements(value.document)].find(
            (node) => node.tagName === "article",
          ) ??
          [...elements(value.document)].find(
            (node) => node.tagName === "main",
          ) ??
          value.document;
        const words = (node: Node): string =>
          node.nodeName === "#text"
            ? (node as Tree["textNode"]).value
            : "tagName" in node && ["script", "style"].includes(node.tagName)
              ? ""
              : "childNodes" in node
                ? node.childNodes.map(words).join(" ")
                : "";
        return {
          location: pageUrl(config, value.locale, value.route),
          title: project.pages[value.locale]![value.pageId]!.title,
          text: words(content).replace(/\s+/gu, " ").trim(),
        };
      });
      await atomicWrite(
        resolve(staging, "search/search_index.json"),
        JSON.stringify(search),
      );
    }
    if (config.routing?.strategy === "subdomain")
      for (const locale of settings.locales) {
        const localizedProject = { ...project, locales: [locale] };
        await atomicWrite(
          resolve(staging, locale.toLowerCase(), "sitemap.xml"),
          sitemapXml(localizedProject),
        );
        const localConfig = {
          ...config,
          site: { ...config.site, url: pageUrl(config, locale, "/") },
        };
        await atomicWrite(
          resolve(staging, locale.toLowerCase(), "robots.txt"),
          robotsTxt({ ...localizedProject, config: localConfig }),
        );
      }
    try {
      await files(output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await safeMkdir(root, output);
    const previous = resolve(cacheDir, `previous-${randomUUID()}`);
    await rename(output, previous);
    try {
      await rename(staging, output);
    } catch (error) {
      await rename(previous, output);
      throw error;
    }
    await rm(previous, { recursive: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return summary;
}
