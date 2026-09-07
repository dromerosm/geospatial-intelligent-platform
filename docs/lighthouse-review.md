# Lighthouse review — 7 September 2026

The target is **strictly above 95 in all four Lighthouse categories**, on both the
landing page and the map, in mobile and desktop navigation tests. The current
release does not meet that target. The audit script reports failure when any
category in any run is 95 or lower.

## Method

Google Lighthouse **13.4.1**, Chrome headless, standard mobile settings and the
standard desktop preset. Each final page/device combination runs three times,
sequentially, with Lighthouse's normal storage reset and simulated throttling.
No URLs are blocked, no audits are skipped within the four requested categories,
and no scores are overridden. There is no special behaviour for audit browsers.

The command is `npm run audit:lighthouse`. An optional origin and repetition count
can be supplied, for example `npm run audit:lighthouse -- https://example.com 3`.
HTML and JSON reports plus `summary.json` are saved in `tmp/lighthouse/final/`.
The script pins the Lighthouse version but uses the installed Chrome; preserve
both versions from each JSON report when comparing a later run.

An initial diagnostic used Lighthouse 13.0.3. Its scores are retained in local
reports but are not mixed into the final 13.4.1 ranges. A DevTools trace of the
landing page observed LCP around 200 ms and CLS 0 without network or CPU throttling;
those measurements are not comparable to Lighthouse's simulated mobile timings.
No CrUX field data was available in that trace.

## Changes shipped

- Serve the unmodified, pinned MapLibre JS and CSS locally, with their license and
  immutable caching. The script is deferred so it does not block HTML parsing.
- Generate a small startup manifest from the versioned territorial dataset. Its
  extent lets the basemap start without waiting for the full cell payload.
- Set the regional camera before the first tile requests, avoiding a second
  framing pass after load.
- Yield between batches when preparing cell colours so input and paint can run.
- Add a repeatable audit command that enforces the requested threshold honestly.

The map still opens automatically. The 9,408 cell geometries and values, layer
scales, event filtering and optional terrain are retained. No backend service or
external data provider was replaced. `map:smoke` verifies that the manifest extent
and counts match the full data. Regenerate it whenever rebuilding the GeoJSON.

In single-run 13.4.1 comparisons, the map's first contentful paint improved from
1.8 s to 0.9 s. Its performance category stayed at 63: the simulated LCP remained
about 8.5 s and total blocking time around 440 ms. Faster initial paint alone is
not sufficient evidence that the full performance target has been met.

## Remaining constraints

The public hostname belongs to the Free Cloudflare zone `diegoromero.es`.
A read-only API check confirmed `fight_mode: true` and `enable_js: true`.
Lighthouse reports deprecated APIs in Cloudflare's injected
`/cdn-cgi/challenge-platform/scripts/jsd/main.js`. Some runs also report CSP issues.
These findings lower Best Practices to 77–81 even on the lightweight landing page.

[Cloudflare documents](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)
that JavaScript Detections cannot be disabled independently under Bot Fight Mode.
Turning it off for this Free zone would affect other sites under the domain.
That broader security change was presented to the owner and has not been applied.
The audit does not hide those scripts or bypass the security layer.

The map also loads a WebGL renderer, vector tiles and the territorial dataset.
Moving the full interactive view behind an explicit “Explore map” action could
reduce the first-navigation workload, but changes how the product opens. That
option was presented separately and has not been implemented. A score for such a
preview would need to be accompanied by separate measurements of the interactive
map; it would not prove that 3D exploration itself has become faster.

[Lighthouse's scoring documentation](https://developer.chrome.com/docs/lighthouse/performance/performance-scoring)
explains that category scores vary with test conditions. This report records lab
runs, not a guarantee for all devices or networks. FCP, LCP and TBT are measured in
milliseconds, CLS is unitless, and category scores run from 0 to 100. A navigation
audit does not establish field INP or frame rate while moving the 3D map.

## Final results: three runs per page and device

| Page | Device | Performance | Accessibility | Best Practices | SEO |
| --- | --- | --- | --- | --- | --- |
| home | mobile | 98–99 | 100 | 77–81 | 100 |
| home | desktop | 100 | 100 | 81 | 100 |
| map | mobile | 62–64 | 100 | 81 | 100 |
| map | desktop | 99–100 | 100 | 81 | 100 |

The threshold command exited **1**, as intended for these failures. This is an
unmet acceptance criterion, not a successful Lighthouse gate. All reports were
produced against the public hostname with the security layer enabled.

## Functional verification and release

Chrome used for the final reports identified itself as HeadlessChrome 152.0.0.0
on macOS. Functional checks passed: TypeScript, 38 platform tests, five terrain
lifecycle tests and the public map smoke check. The browser also loaded satellite
terrain with the 481 weather markers after the startup changes.

The audited map code was published in Pages deployment `f83eb84e`. Subsequent
changes to documentation and verification scripts do not alter the audited HTML,
JavaScript, styles or territorial data. No Worker or zone security configuration
was deployed for this performance change. The regional event fix remains in place.

The changes follow elon-algo: keep the requested automatic map, remove an avoidable
CDN connection and redundant camera pass, simplify startup with existing data,
then automate measurement. The remaining product and zone-security decisions are
explicit rather than hidden in the implementation.
