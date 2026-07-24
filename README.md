# Seer

Build-time localization, JSON content, and search metadata for static and
server-rendered websites.

Seer reads one `content/shared.json`, one `content/<locale>.json` per language,
and `content/config.toml`. It validates its schema before deployment, merges
shared data with one locale at a time, and emits:

- framework-neutral locale JSON;
- canonical, `hreflang`, Open Graph, Twitter, robots, and JSON-LD helpers;
- `robots.txt` and `sitemap.xml`.

One runtime dependency parses TOML. Seer ships no browser runtime, React
context, framework adapter, watcher, server, crawler, or rate limiter.

## Install

After the first npm release:

```sh
npm install --save-dev @keys-i/seer
```

```json
{
  "scripts": {
    "content:check": "seer check",
    "content:build": "seer build"
  }
}
```

Seer requires Node 24.18 or newer.

## Files

```text
content/
  config.toml
  shared.json
  en.json
  es.json
```

`shared.json` owns stable IDs, asset paths, and non-translated data. Locale
files own human-language strings and localized routes. Objects merge
recursively; arrays replace. There is no implicit fallback that could hide a
missing translation. Locales must keep the default locale's keys, primitive
types, and array shapes. Use keyed objects for locale-specific lists and the
`validate` callback for an application's deeper content schema.

## Configuration

```toml
version = 1
default_locale = "en"

[site]
name = "Example"
url = "https://example.com"

[output]
public_dir = "public"

[robots]
disallow = ["/api/", "/admin/"]
block_agents = ["GPTBot", "ClaudeBot"]
```

Unknown config keys fail. Output directories cannot escape, overlap the source,
overlap each other, or traverse existing symlinks. The site URL must be a bare
HTTPS origin.

Seer cannot prove how a framework renders by reading a config claim. The host
must put primary content and head metadata in the initial static or SSR HTML;
CSR-only output is unsupported.

## Content and pages

Stable, non-translated fields remain in `shared.json`:

```json
{
  "seo": {
    "pages": {
      "home": {
        "image": "/og.png"
      }
    }
  }
}
```

Translated metadata stays in each locale:

```json
{
  "seo": {
    "pages": {
      "home": {
        "path": "/",
        "title": "A useful, specific page title",
        "description": "A truthful summary of the visible page.",
        "image_alt": "A useful description of the social image."
      }
    }
  },
  "home": {
    "heading": "Visible in the initial HTML"
  }
}
```

Optional page fields are `image`, `image_alt`, and `noindex`. Every locale must
define the same page IDs and `noindex` policy. Seer never invents reviews,
ratings, FAQs, keywords, authors, or dates.

## Build

```sh
npx seer check
npx seer build
```

The default output is:

```text
.seer/
  content/<locale>.json
public/
  robots.txt
  sitemap.xml
```

Import only the generated locale needed by the current route. For SEO, load the
project once at build/start time and map the neutral data through your
framework's native head API:

```ts
import { headData, readProject, serializeJsonLd } from "@keys-i/seer";

const project = await readProject();
const metadata = headData(project, "en", "home");
const jsonLd = serializeJsonLd(metadata.jsonLd);
```

Set `<html lang={metadata.lang} dir={metadata.dir}>`; map `title`,
`description`, `canonical`, `alternates`, `robots`, image fields, Open Graph,
and Twitter cards with the framework's escaped components. Put `jsonLd` in one
`application/ld+json` script. Do not read project files per request; cache the
returned project for SSR.

Applications may add one schema validator without changing Seer:

```ts
const project = await readProject({
  validate(content, locale) {
    // Throw when application-specific content is invalid.
  },
});
```

## SEO and AI search

There is no secret AEO markup. Search and AI-search systems reward the same
basics: useful visible text, crawlable static/SSR pages, stable canonical
URLs, internal links, localized alternates, accurate structured data, and
fast delivery.

Seer therefore emits only evidence-backed metadata:

- a localized title and description for every locale/page;
- same-origin canonical URLs and reciprocal `hreflang`, including
  `x-default`;
- generic `WebSite` and `WebPage` JSON-LD;
- indexable canonical URLs in the sitemap;
- explicit crawler policy in `robots.txt`.

Google explicitly says no special AI file or schema is required for AI
Overviews or AI Mode, so Seer does not generate `llms.txt`.
Add truthful `Organization`, `Article`, `Product`, or other page-specific
schema in the host only when its visible content supports the claims.

References:

- [Google: AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)
- [Google: localized pages](https://developers.google.com/search/docs/advanced/crawling/localized-versions)
- [Google: structured-data policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
- [OpenAI: publishers and developers](https://help.openai.com/en/articles/12627856-publishers-and-developers-faq)
- [Robots Exclusion Protocol, RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html)

## Bots and DDoS

`robots.txt` is a request to cooperative crawlers. User-Agent strings are
spoofable. Neither Seer nor any build-time TypeScript package can stop
scraping, abusive agents, or DDoS traffic.

Production must enforce this at the edge:

1. Put the origin behind a CDN with managed DDoS protection and caching.
2. Lock the origin so clients cannot bypass the CDN.
3. Verify known bots by provider IP ranges or signatures, not User-Agent
   alone.
4. Rate-limit expensive paths for unverified traffic and return `429` with
   `Retry-After`.
5. Challenge or block unknown automation and monitor false positives.
6. Protect mutations with authentication, authorization, CSRF defenses,
   idempotency, and quotas.

Block training crawlers at both `robots.txt` and the WAF if enforcement
matters. Allow verified search crawlers so the site remains discoverable.

[Cloudflare's rate-limiting guidance](https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/)
describes the enforcement layer Seer deliberately does not fake.

## Security limits

- maximum JSON file size: 5 MiB;
- maximum aggregate JSON size: 25 MiB and 256 locales;
- maximum generated locale JSON: 50 MiB;
- maximum TOML size: 256 KiB;
- maximum JSON depth: 64;
- prototype-pollution keys rejected;
- page-ID and indexability parity required across locales;
- sitemap protocol limit: 50,000 URLs;
- canonical paths, crawler tokens, URLs, config keys, and output paths
  validated; input files and existing output directories cannot be symlinks;
- XML escaped and JSON-LD serialization protected against script termination;
- no network access, remote includes, templates, `eval`, or per-request file
  reads.

Seer validates metadata. Your framework must still escape localized content
when rendering HTML.

## Deliberate omissions

No runtime translator, fallback locale, dotted-key `t()`, locale detection,
React context, plugin system, framework adapters, client fetches, deep array
merge, generated SEO mirror, crawler middleware, `crawl-delay`, IndexNow,
`llms.txt`, keyword generator, AI-written copy, or in-memory rate limiter.

Add a feature only after two real consumers need the same behavior.
