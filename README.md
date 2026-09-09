# Seer

Build-time localization, JSON content, and search metadata for static and
server-rendered websites.

[Live static demo](https://keys-i.github.io/seer/) · [generated locale JSON](https://keys-i.github.io/seer/content/en.json)

Seer reads one `content/shared.json`, one `content/<locale>.json` per language,
and `content/config.toml`. It validates its schema before deployment, merges
shared data with one locale at a time, and emits:

- framework-neutral locale JSON;
- canonical, `hreflang`, Open Graph, Twitter, robots, and JSON-LD helpers;
- `robots.txt` and `sitemap.xml`.

Build dependencies parse TOML and HTML. Seer ships no browser runtime, React
context, framework adapter, watcher, server, crawler, or rate limiter.

## Install

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

Seer is ESM-only and requires Node 24.18 or newer.

## Localise an existing website

Seer can process the HTML your existing site generator already builds. It
writes the translated pages, language switcher, canonical URLs, reciprocal
`hreflang`, structured metadata and sitemaps together. No translation runtime
or framework adapter is added to the browser.

Put this in `locales/config.toml`:

```toml
version = 1
default_locale = "en"

[site]
name = "My notes"
url = "https://example.com/"

[output]
public_dir = "public"

[routing]
strategy = "subdirectory"

[localization]
source_dir = ".seer-source"
locales = ["en", "as", "bn", "brx", "doi", "gu", "hi", "kn", "kok", "ks", "mai", "ml", "mni", "mr", "ne", "or", "pa", "sa", "sat", "sd", "ta", "te", "ur"]
exclude = ["/404.html", "/print_page/"]
preserve = ["My notes", "Seer"]
```

Build your original site into `.seer-source`, then run:

```sh
seer localize --translate
```

`--translate` explicitly enables requests to Sarvam using `SARVAM_API_KEY`.
The service may charge for these requests. The key is read from the environment
and is never written into generated pages or catalogs. All 22 supported Indian
languages use the same workflow and checks, with Odia's `or` locale mapped to
the provider's `od-IN` code. No language requires a special certification or a
particular reviewer to be included.

For offline editing, `seer localize --extract` creates the catalogs and reports
missing entries without calling a service. Fill their `translation` fields
with your preferred translator or edit generated translations directly.
`seer localize` then builds entirely offline. It fails before replacing the
published site if any translation is missing, stale or fails validation.
Rebuilds reuse unchanged translations, including your corrections. Keep the
catalogs with your site sources.

Sentences keep their inline emphasis and links. Code, formulas, URLs, numbers,
`translate="no"` regions and configured terms are protected. Checks catch
missing placeholders, unchanged source text and an unexpected output script;
they are useful error checks, not a claim that meaning or fluency is certified.
Provider request IDs are recorded for generated entries. Notes' existing
Material interface labels and search index are localised without new browser
JavaScript; search results link to each translated page.

`subdirectory` emits `/en/guide/`, `/hi/guide/` and so on, including the source
language. Existing source URLs remain available with canonical links to the
source-language routes. Assets remain shared at the original site URL.
Generated pages preserve their source URL base so responsive images and inline
CSS keep resolving shared assets. Index-file and fragment links stay in the
selected language, and existing HTML `base` elements are respected.
`subdomain` instead emits `https://en.example.com/guide/` and
`https://hi.example.com/guide/`, with a separate deploy directory, sitemap and
robots file per locale. Serve each locale directory at its configured hostname
and base path; DNS and TLS configuration belong to the hosting service. Keep
the shared assets available at the original site URL.
Excluded and `noindex` HTML pages are also copied into each subdomain's deploy
directory without translation. Allow the shared asset origin in your content
security policy and enable CORS there for fonts and module scripts when needed.

The JSON-content workflow below remains available. With `[routing]` enabled,
its page paths are language-neutral (`/guide/`); Seer adds the locale itself.
Without `[routing]`, existing manually localised paths keep their behavior.

## Files

```text
content/
  config.toml
  shared.json
  en.json
  es.json
  ja.json
  ko.json
  zh-Hans.json
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
url = "https://example.com/"

[output]
public_dir = "public"

[robots]
disallow = ["/api/", "/admin/"]
block_agents = ["GPTBot", "ClaudeBot"]
```

Unknown config keys fail. Output directories cannot escape, overlap the source,
overlap each other, or traverse existing symlinks. The site URL must be an HTTPS
base URL; a path base must end in `/`, such as
`https://example.github.io/project/`. Page paths resolve inside that base.
Images accept relative or absolute HTTPS URLs.

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

## GitHub Action

The root action runs the same structural validation and writes a job summary
beginning with `## Locale`. It needs no token, network access, runtime install,
or write permission. Outputs are `locales` (JSON), `locale-count`, and
`default-locale`. The summary reports schema, key, type, array-shape, page-ID,
and indexability parity. It does not score fluency or translation accuracy.

Use the immutable commit instead of a mutable tag:

```yaml
name: Locale

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - id: locale
        uses: keys-i/seer@fe739a3fb3df7f83fcd95b663399cbce5896bf28
        with:
          directory: content
      - name: Confirm locale count
        env:
          LOCALE_COUNT: ${{ steps.locale.outputs.locale-count }}
        run: test "$LOCALE_COUNT" -gt 0
```

Marketplace publication also has a GitHub owner UI gate; [issue #19](https://github.com/keys-i/seer/issues/19)
stays open until the live listing and an external pinned run are verified.

## SEO and AI search

There is no secret AEO markup. Search and AI-search systems reward the same
basics: useful visible text, crawlable static/SSR pages, stable canonical
URLs, internal links, localized alternates, accurate structured data, and
fast delivery.

Seer therefore emits only evidence-backed metadata:

- a localized title and description for every locale/page;
- canonical URLs for the configured locale routes and reciprocal `hreflang`, including
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

Serve the generated file at the origin's `/robots.txt`; a file below a project
path is only a demo artifact because the protocol defines the origin-root
location.

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
- maximum aggregate generated locale JSON: 50 MiB;
- maximum TOML size: 256 KiB;
- maximum JSON depth: 64 and 1,000,000 container entries per document;
- input must be valid UTF-8 and contain well-formed Unicode;
- non-finite numbers and integers outside JavaScript's safe range rejected;
- prototype-pollution keys rejected;
- page-ID and indexability parity required across locales;
- sitemap limits: 50,000 URLs, less than 2,048 characters per URL, and 50 MiB;
- generated `robots.txt` capped at the 500 KiB interoperability floor;
- canonical paths, crawler tokens, URLs, config keys, and output paths
  validated; output paths are capped at 32 portable components and 512 bytes;
  the final content directory entry and input files cannot be symlinks, and
  existing output components cannot be symlinks or filesystem aliases;
- XML escaped and JSON-LD serialization protected against script termination;
- no remote includes, templates, `eval`, or per-request file reads; network
  translation occurs only with the explicit `localize --translate` option.

These rejection limits bound work but do not promise that maximum accepted
content fits a 64 MiB heap; constrained-heap tests target amplification paths.

Seer validates metadata. Your framework must still escape localized content
when rendering HTML.

## Runtime scope

Seer works at build time. It does not add locale detection, a client-side
translator or crawler middleware. Pages already rendered by JavaScript alone
must first be statically rendered by the host. Arbitrary executable script
strings are preserved; data-driven client applications can use the JSON
content workflow.
