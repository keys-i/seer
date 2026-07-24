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
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function serializeJsonLd(value: JsonObject) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

const absolute = (project: Project, value: string) =>
  new URL(value, project.config.site.url).href;

function page(project: Project, locale: string, pageId: string) {
  const value = project.pages[locale]?.[pageId];
  if (!value) throw new Error(`unknown page: ${locale}/${pageId}`);
  return value;
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
  const rules = project.config.robots.disallow.map(
    (path) => `Disallow: ${path}`,
  );
  const lines = ["User-agent: *", "Allow: /", ...rules, ""];

  for (const agent of project.config.robots.blockAgents) {
    lines.push(`User-agent: ${agent}`, "Disallow: /", "");
  }
  lines.push(`Sitemap: ${absolute(project, "/sitemap.xml")}`, "");
  return lines.join("\n");
}

export function sitemapXml(project: Project) {
  const urls = project.locales
    .flatMap((locale) =>
      Object.values(project.pages[locale]!)
        .filter((value) => !value.noindex)
        .map((value) => absolute(project, value.path)),
    )
    .sort()
    .map((loc) =>
      [
        "  <url>",
        `    <loc>${xml(loc)}</loc>`,
        "  </url>",
      ].join("\n"),
    );
  if (urls.length > 50_000) {
    throw new Error("sitemap exceeds the 50,000 URL protocol limit");
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}
