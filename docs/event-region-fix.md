# Regional event filtering and Telegram locations

## Cause

FIRMS ingestion requests the Aragón bounding box, which also includes parts of
neighbouring regions and France. The engine previously treated a missing digital
twin row as unknown context and continued scoring. Persistent detections outside
Aragón could therefore become events, receive regional weather context, generate
an AI briefing and reach Telegram with only an H3 identifier as their location.

The production check on 7 September 2026 found four active events outside the
polygon-derived regional H3 coverage. Two had already been notified. All 9,408
cells in the deployed twin had a municipality; this was not a missing-name problem
within the supported grid.

| H3 cell | Approximate centre (latitude, longitude) | Previously notified |
| --- | --- | --- |
| `8739666d6ffffff` | 42.9022, 0.4593 | Yes |
| `87397101affffff` | 41.5120, 0.6165 | Yes |
| `873973319ffffff` | 40.5647, 0.5461 | No |
| `873975918ffffff` | 42.9201, -0.5507 | No |

## Correction

The engine now requires a digital twin row before selecting regional weather,
scoring, creating or updating an event, generating a briefing, or notifying
Telegram. Rejected clusters are audited as `outside_territorial_coverage`; each
engine pass records their count as `outsideCoverage`.

The regional footprint is the existing H3 resolution-7 grid built with
`polygonToCells` from the Aragón boundary. This deliberately uses the same
territorial coverage as the map. It is a cell-centre approximation, not an exact
point-in-polygon test for every satellite footprint at the border. A missing twin
row means unsupported coverage; it is never treated as proof of an active fire
or assigned the nearest municipality. If coverage is accidentally missing, events
for those cells are suppressed until the twin is restored.

Migration `0012_close_events_outside_coverage.sql` closes active events without a
matching twin row and writes a per-event audit record. It preserves observations,
briefings, notification timestamps and event history. The closure means the event
is outside this platform's coverage, not that a fire has ended. An empty twin
makes the migration a no-op, so a fresh development database does not close all
its events. Closed historical records are left untouched.

Telegram messages now include municipality, Aragón, and the approximate H3 cell
centre as latitude/longitude, followed by the existing event link. The wording
identifies the coordinate as a cell centre, not an exact ignition point. If a
covered cell lacks a municipality in a future dataset, coordinates remain visible
and the missing name is stated explicitly. HTML is escaped as before.

Previously delivered Telegram messages are not edited or resent by this change.
The map's active event list stops showing the withdrawn events; their historical
records remain available through `/events?status=closed`.

## Decisions following elon-algo

The requirement is regional event coverage with a useful location. A new reverse
geocoder would hide the coverage bug and add another dependency, so it was rejected.
The existing twin already provides both region membership and municipality. The
filter runs before external AI and notification calls, avoiding unnecessary work.
Regression tests cover the four affected cells, a valid Zaragoza event, coordinate
fallback and HTML escaping. No new provider, secret or package is needed.

## Validation and operations

- `npm run typecheck`: passed.
- `npm test`: 38 tests passed, including five new engine/message tests.
- `npm run map:check`: syntax and five terrain tests passed.
- `npm run deploy -- --dry-run`: Worker bundle succeeded.
- SQLite migration checks: retained a covered active event, closed an uncovered
  event, kept an already closed event and all briefings, wrote the expected audit
  row, safely repeated, and did nothing when the twin was empty.

AI generation and Telegram transport were mocked in regression tests. No test
messages were sent to the operations chat. Existing priority and deduplication
rules continue to apply to normal scheduled processing.

Deploy the Worker before applying migration 0012 so the old engine cannot recreate
withdrawn events. Verify `/events`, the coverage audit records and the next scheduled
engine pass. Rollback requires restoring the previous Worker only if necessary;
do not reopen the withdrawn events without first checking their regional coverage.

Production Worker version: `9f6717fc-daf3-4aab-9f48-651b560624e9`.
Migration 0012 completed at `2026-09-07T06:38:08.104Z`: all four affected events
were closed, four audit rows were added, and the two earlier notification
timestamps were preserved. A follow-up query found zero uncovered active events.
The public map smoke checks passed (9,408 cells, 481 weather points, 100 recent
observations, zero active events). The browser showed “Eventos: ninguno activo
ahora”, no event markers, and no map error message. The next scheduled engine run
was not manually triggered during this verification.
