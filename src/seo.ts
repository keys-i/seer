import type { JsonObject, PageSeo, Project } from "./project.js";

export interface HeadData {
  lang: string;
  dir: "ltr" | "rtl";
  siteName: string;
  title: string;
  description: string;
  canonical: string;
  robots?: "noindex";
  alternates: Record<string, string>;
  image?: string;
  imageAlt?: string;
  jsonLd: JsonObject;
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("'", "&apos;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function serializeJsonLd(value: JsonObject) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

const absolute = (project: Project, value: string) =>
  new URL(
    value.startsWith("/") && !value.startsWith("//") ? `.${value}` : value,
    project.config.site.url,
  ).href;

function page(project: Project, locale: string, pageId: string) {
  const pages = Object.hasOwn(project.pages, locale)
    ? project.pages[locale]
    : undefined;
  if (!pages || !Object.hasOwn(pages, pageId)) {
    throw new Error(`unknown page: ${locale}/${pageId}`);
  }
  return pages[pageId]!;
}

function jsonLd(project: Project, locale: string, value: PageSeo): JsonObject {
  const canonical = absolute(project, value.path);
  const origin = project.config.site.url.replace(/\/$/, "");
  const websiteId = `${origin}/#website`;
  const graph: JsonObject[] = [{
    "@type": "WebSite",
    "@id": websiteId,
    url: project.config.site.url,
    name: project.config.site.name,
    inLanguage: project.locales,
  }];

  graph.push({
    "@type": "WebPage",
    "@id": `${canonical}#webpage`,
    url: canonical,
    name: value.title,
    description: value.description,
    inLanguage: locale,
    isPartOf: { "@id": websiteId },
  });

  return { "@context": "https://schema.org", "@graph": graph };
}

export function headData(
  project: Project,
  locale: string,
  pageId: string,
): HeadData {
  const value = page(project, locale, pageId);
  const canonical = absolute(project, value.path);
  const alternates = Object.fromEntries(
    project.locales.map((otherLocale) => [
      otherLocale,
      absolute(project, page(project, otherLocale, pageId).path),
    ]),
  );
  alternates["x-default"] = alternates[project.config.defaultLocale]!;
  const image = value.image ? absolute(project, value.image) : undefined;

  return {
    lang: locale,
    dir: (
      new Intl.Locale(locale) as Intl.Locale & {
        getTextInfo(): { direction: "ltr" | "rtl" };
      }
    ).getTextInfo().direction,
    siteName: project.config.site.name,
    title: value.title,
    description: value.description,
    canonical,
    ...(value.noindex ? { robots: "noindex" as const } : {}),
    alternates,
    ...(image ? { image, imageAlt: value.imageAlt } : {}),
    jsonLd: jsonLd(project, locale, value),
  };
}

export function robotsTxt(project: Project) {
  const basePath = new URL(project.config.site.url).pathname;
  const prefix = basePath === "/" ? "" : basePath.slice(0, -1);
  let bytes = 0;
  let result = "";
  const append = (...parts: string[]) => {
    bytes += parts.reduce((total, part) => total + Buffer.byteLength(part), 1);
    if (bytes > 500 * 1024) {
      throw new Error("robots.txt exceeds the 500 KiB interoperability limit");
    }
    result += `${parts.join("")}\n`;
  };

  append("User-agent: *");
  if (project.config.robots.disallow.length) {
    for (const path of project.config.robots.disallow) {
      append("Disallow: ", prefix, path);
    }
  } else {
    append("Disallow:");
  }
  append("");

  for (const agent of project.config.robots.blockAgents) {
    append("User-agent: ", agent);
    append("Disallow: ", basePath);
    append("");
  }
  append("Sitemap: ", absolute(project, "/sitemap.xml"));
  return result;
}

export function sitemapXml(project: Project) {
  const pages = project.locales
    .flatMap((locale) =>
      Object.values(project.pages[locale]!)
        .filter((value) => !value.noindex),
    );
  if (pages.length > 50_000) {
    throw new Error("sitemap exceeds the 50,000 URL protocol limit");
  }
  const header = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ].join("\n") + "\n";
  const footer = "</urlset>\n";
  let bytes = Buffer.byteLength(header) + Buffer.byteLength(footer);
  const entries: Array<readonly [string, string]> = [];
  for (const value of pages) {
    const loc = absolute(project, value.path);
    if (loc.length >= 2_048) {
      throw new Error("sitemap URL must be shorter than 2,048 characters");
    }
    const entry = [
      "  <url>",
      `    <loc>${xml(loc)}</loc>`,
      "  </url>",
    ].join("\n") + "\n";
    bytes += Buffer.byteLength(entry);
    if (bytes > 50 * 1024 * 1024) {
      throw new Error("sitemap exceeds the 50 MiB protocol limit");
    }
    entries.push([loc, entry]);
  }
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return header + entries.map(([, entry]) => entry).join("") + footer;
}
