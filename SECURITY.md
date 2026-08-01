# Security

Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/keys-i/seer/security/advisories/new),
not a public issue. Only the latest release is supported.

Seer treats TOML and JSON as untrusted build input: it limits file, aggregate,
robots, sitemap, and generated-content size; requires valid UTF-8; rejects
non-finite numbers and unsafe integers; limits JSON depth; rejects
prototype-pollution keys, noncanonical paths, symlinked input files and final
content-directory entries, and aliased output components; validates URLs; and
escapes generated XML and serialized JSON-LD. Ancestor aliases are resolved to
their canonical target. This assumes the repository is not being modified
concurrently by an attacker while Seer runs.

Seer is not a firewall. `robots.txt` is advisory and User-Agent headers are
spoofable. Protect deployed sites with CDN caching, managed DDoS/WAF rules,
verified-bot identity, locked origins, route-aware rate limits, and
authentication for mutations.
