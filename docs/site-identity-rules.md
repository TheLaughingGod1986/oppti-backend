# Site Identity Rules

## Purpose

BeepBeep AI grants free quota, trial quota, and paid entitlements at the WordPress site level. To enforce that safely, the backend normalizes and matches site identity consistently across auth, generation, usage, and billing flows.

## Inputs

The backend accepts these site identity signals:

- `install_uuid` / `X-Install-UUID`
- `site_id` / `site_hash` / `X-Site-Key` / `X-Site-Hash`
- `site_fingerprint` / `X-Site-Fingerprint`
- `site_url` / `X-Site-URL`

## Normalization rules

### Host and domain

- lowercase the host
- strip trailing dots
- remove `www.` prefix
- preserve meaningful subdomains (`shop.example.com` stays distinct from `example.com`)

### URL

- allow `http` and `https`
- if protocol is missing, assume `https://`
- strip default ports (`:80` on `http`, `:443` on `https`)
- trim trailing slashes
- preserve non-root path segments if supplied
- truncate normalized URL to 500 characters

Examples:

| Raw input | Normalized result |
|---|---|
| `HTTPS://WWW.Example.com:443/wp-admin/` | `example.com/wp-admin` |
| `https://shop.example.com/store/` | `shop.example.com/store` |
| `example.com` | `example.com` |

### Install UUID and site hash

- trim whitespace
- truncate to 255 characters
- prefer `install_uuid` as the strongest signal when available
- preserve legacy `site_hash` for backward compatibility

### Fingerprint

- trim whitespace
- truncate to 255 characters
- store both `site_fingerprint` and legacy `fingerprint` until cleanup is complete

## Development/localhost protection

These hosts are treated as development-like:

- `localhost`
- loopback IPs
- RFC1918/private IPs
- `.local`
- `.localhost`
- `.test`
- `.invalid`
- `.example`
- `.internal`

In production, development-like sites cannot claim production quota unless:

- `ALLOW_DEV_SITE_QUOTA=true`

This prevents localhost/dev installs from repeatedly claiming fresh free quota in production.

## Synthetic site hash

If no explicit `site_hash` exists, the backend derives a synthetic deterministic hash from:

- `wp_install_uuid`
- `site_hash`
- `site_fingerprint`
- normalized site URL
- canonical domain

The synthetic hash is only a fallback. It is not preferred over explicit install/site identifiers.

## Matching order

When resolving a canonical site, use this order:

1. exact `wp_install_uuid`
2. exact `site_hash`
3. exact `site_fingerprint`
4. exact legacy `fingerprint`
5. exact `normalized_site_url`
6. exact `canonical_domain` if there is exactly one candidate
7. manual review / merge if domain match is ambiguous

## Ambiguity handling

Do not silently create a new site when:

- multiple active/unmerged sites share the same `canonical_domain`
- the incoming identity only resolves to an ambiguous domain group

Instead:

- return `AMBIGUOUS_SITE_MATCH`
- log `ambiguous_site_match` in `site_audit_logs`
- resolve manually with `bbai_merge_sites(...)` or `scripts/merge-sites.js`

## Reinstall and reconnect behavior

The same site should resolve back to the same canonical record when any strong signal still matches:

- same install UUID
- same explicit site hash
- same fingerprint
- same normalized URL/domain

Changing email must never be enough to obtain a new site quota.

## Trust model

- plugin-provided site signals are trusted as hints, not as sole proof
- Stripe metadata is trusted only as attribution context, then reconciled against canonical site/account state
- ambiguous matches must be reviewed, not auto-merged
