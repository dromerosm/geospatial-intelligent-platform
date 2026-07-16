# Security Policy

This is a personal MVP research project, but security reports are welcome and taken
seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/dromerosm/geospatial-intelligent-platform/security/advisories/new)
(**Security → Advisories → Report a vulnerability**). Include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected endpoint, file, or component.

You can expect an initial acknowledgement within a few days. Once a fix is available,
the advisory is published with credit to the reporter (unless you prefer to stay
anonymous).

## Scope

- The Cloudflare Worker and its public API (`https://geospatial-platform.diegoromero.es`).
- Source in this repository.

Out of scope: the upstream data providers (NASA FIRMS, Open-Meteo, AEMET, GDACS,
Copernicus/EFFIS, INE) and Cloudflare's own platform — report those to the respective
vendors.

## Handling of secrets

All credentials (API keys, tokens) are Worker secrets and are never committed. The
`/dev/*` maintenance endpoints are gated behind a `DEV_TOKEN` shared secret and return
`404` when it is unset. See [`docs/deploy.md`](docs/deploy.md).
