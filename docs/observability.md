# Observability baseline

This document describes the logs, metrics, SLOs, alerts, and dashboards that
ship with wormhole. Everything is designed to work with the standard
Prometheus/Grafana stack and without adding a runtime dependency to the API.

## Structured logs

Every log line is a single JSON object written to stdout (`debug`, `info`) or
stderr (`warn`, `error`). The schema is:

| Field       | Description                                                     |
| ----------- | --------------------------------------------------------------- |
| `timestamp` | ISO-8601 timestamp with milliseconds                            |
| `level`     | `debug`, `info`, `warn`, or `error`                             |
| `service`   | Always `wormhole`                                               |
| `message`   | Human-readable event name                                       |
| `requestId` | Present on request-scoped lines; correlates a request end-to-end |
| _context_   | Event-specific fields such as `method`, `route`, `status`, `durationMs`, `error`, `code` |

Set the minimum level with `LOG_LEVEL` (default `info`).

### Request correlation

`X-Request-ID` is accepted from the caller when it is 1-128 characters from
`[A-Za-z0-9._:-]`. Otherwise the server generates a UUID. The value is echoed
in the response header and stored in `AsyncLocalStorage`, so access logs,
error logs, and database logs produced while handling the request all carry the
same `requestId`.

```bash
curl -i -H 'X-Request-ID: demo-request-1' http://localhost:3000/shorten/abc123
```

```json
{"timestamp":"2026-11-11T12:34:56.789Z","level":"info","service":"wormhole","message":"HTTP request completed","requestId":"demo-request-1","method":"GET","route":"/shorten/:id","status":200,"durationMs":1.234}
```

Access-log fields are deliberately bounded: `method`, the matched route
pattern (`/shorten/:id`, not the raw short code), `status`, `durationMs`, and
`requestId`. Unmatched requests use the route label `unmatched`. Requests to the
operational endpoints (`/healthz`, `/readyz`, and `/metrics`) are not
access-logged or counted in RED metrics, so probes and scrapes cannot dilute the
user-facing error rate or inflate their own signals.

### Error logs

Expected 4xx failures are logged at `warn` by the access logger. Unexpected
errors are logged at `error` with `name`, `message`, `stack`, and `code`.
Request bodies, headers, query strings, and pg's row-level fields (`detail`,
`hint`, `where`) are never logged.

Redaction is applied to every string and object field:

- Object keys matching `password`, `secret`, `token`, `api_key`,
  `authorization`, `cookie`, `credential`, or `session` become `[REDACTED]`.
- URL userinfo, query strings, and fragments are replaced before a URL is
  written. This includes PostgreSQL connection strings.
- Common `password=...`, `token=...`, `Authorization: Bearer ...`, and similar
  assignments inside free-form messages are redacted.

## Metrics

`GET /metrics` exposes Prometheus text format (`text/plain; version=0.0.4`).
The endpoint is unauthenticated by design; keep it on a private interface or
restrict it at the ingress/load balancer.

| Metric | Type | Labels | Meaning |
| ------ | ---- | ------ | ------- |
| `wormhole_http_requests_total` | counter | `method`, `route`, `status` | Request count (RED "rate" and "errors") |
| `wormhole_http_request_duration_seconds` | histogram | `method`, `route` | Request latency (RED "duration") |
| `wormhole_database_up` | gauge | - | Last health check result (`1` up, `0` down) |
| `wormhole_database_health_checks_total` | counter | `status` (`up`/`down`) | Database probe outcomes |
| `wormhole_db_pool_total_connections` | gauge | - | Checked-out plus idle pool clients |
| `wormhole_db_pool_idle_connections` | gauge | - | Idle pool clients |
| `wormhole_db_pool_waiting_clients` | gauge | - | Requests waiting for a connection |
| `wormhole_db_pool_max_connections` | gauge | - | Pool limit |
| `wormhole_build_info` | gauge | `version`, `commit` | Build identity; always `1` |

The database probe runs independently of HTTP traffic every
`DB_HEALTH_CHECK_INTERVAL_MS` (default 5000 ms), so availability stays accurate
when no requests are arriving. Pool gauges are sampled at scrape time. Health
probes and `/metrics` scrapes are excluded from the request metrics, so RED
signals reflect API traffic rather than monitoring traffic.

The latency histogram buckets are 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 300ms,
500ms, 1s, 2.5s, 5s, and 10s, plus `+Inf`. The 300ms and 1s boundaries line up
with the p95 and p99 SLOs, so the alerting quantiles are not smeared across a
wide bucket.

## SLOs

Targets over a rolling 30-day window:

| SLI | Target | PromQL |
| --- | ------ | ------ |
| Availability (non-5xx) | 99.9% | `sum(rate(wormhole_http_requests_total{status!~"5.."}[30d])) / sum(rate(wormhole_http_requests_total[30d]))` |
| Error ratio (5xx) | <= 0.1% | `sum(rate(wormhole_http_requests_total{status=~"5.."}[30d])) / sum(rate(wormhole_http_requests_total[30d]))` |
| p95 latency | <= 300ms | `histogram_quantile(0.95, sum by (le) (rate(wormhole_http_request_duration_seconds_bucket[30d])))` |
| p99 latency | <= 1s | `histogram_quantile(0.99, sum by (le) (rate(wormhole_http_request_duration_seconds_bucket[30d])))` |

A 99.9% availability target allows about 43 minutes of failed requests every
30 days; that is the same as a 0.1% error-ratio budget. The p95/p99 targets are
measured over successful and failed requests alike, because a failure that
returns quickly can otherwise hide a slow tail. Fast-burn alerts use 5-10
minute windows, while a 30-minute warning tracks a 0.5% error rate (five times
the budget) so the team hears about SLO pressure before the monthly target is
exhausted.

The bundled Prometheus keeps seven days of data, so the 30-day queries above
need a long-term metrics backend (or a longer retention setting) to be
meaningful outside local development.

## Alerts

Rules live in [`observability/alerts.yml`](../observability/alerts.yml). They
are evaluated by Prometheus and routed through Alertmanager.

| Alert | Condition | For | Severity |
| ----- | --------- | --- | -------- |
| `WormholeDatabaseUnavailable` | `wormhole_database_up == 0` | 30s | critical |
| `WormholeHighErrorRate` | 5xx ratio > 5% | 5m | critical |
| `WormholeElevatedErrorRate` | 5xx ratio > 0.5% (5x budget) | 30m | warning |
| `WormholeHighP95Latency` | p95 > 300ms | 10m | warning |
| `WormholeHighP99Latency` | p99 > 1s | 10m | critical |
| `WormholeDatabasePoolSaturated` | in-use pool connections > 90% of max | 10m | warning |
| `WormholeDatabasePoolWaiters` | any client waited for a connection | 5m | warning |

### Database unavailable

1. Check `wormhole_database_up` and `wormhole_database_health_checks_total` on
   the dashboard.
2. Check PostgreSQL (`docker compose -f compose.yml -f compose.dev.yml ps`).
3. Search error logs for `requestId`s from the Grafana/Prometheus time window;
   `database unavailable while handling request` entries include the pg error
   code but not credentials.
4. `/readyz` returns `503` with `Retry-After: 1` during the outage and recovers
   automatically when PostgreSQL returns.

### High error rate

Filter access logs for `status >= 500`, take a `requestId`, and find the
matching `unhandled request error` entry for the stack trace. Compare the
start time with the database availability panel.

### Latency

The latency panels break down p50/p95/p99. Check database pool waiters first,
then whether the slow traffic is concentrated in one route. A high
`wormhole_db_pool_waiting_clients` value means requests are queued for a
connection rather than doing work.

### Pool saturation

`wormhole_db_pool_total_connections - wormhole_db_pool_idle_connections` near
`wormhole_db_pool_max_connections` means the process is using all of its
clients. Check for slow queries and consider raising the pg pool size only
after confirming PostgreSQL can handle more concurrent work. Waiters are the
clearest symptom: with a healthy database,
`wormhole_db_pool_waiting_clients` should stay at `0`.

## Dashboards and local stack

Start the observability stack alongside the database and API:

```bash
# Terminal 1: database
docker compose -f compose.yml -f compose.dev.yml up -d

# Terminal 2: API
npm run dev

# Terminal 3: Prometheus, Alertmanager, Grafana
docker compose -f compose.observability.yml up -d
```

| Service | URL | Notes |
| ------- | --- | ----- |
| Prometheus | http://localhost:9090 | Targets, rules, and PromQL |
| Alertmanager | http://localhost:9093 | Active alerts and silences |
| Grafana | http://localhost:3001 | `admin` / `admin` by default; set `GRAFANA_ADMIN_PASSWORD` |

The dashboard `Wormhole RED and Database` is provisioned automatically from
[`observability/grafana/dashboards/wormhole.json`](../observability/grafana/dashboards/wormhole.json).
Prometheus scrapes `host.docker.internal:3000`; edit
[`observability/prometheus.yml`](../observability/prometheus.yml) if
`WORMHOLE_PORT` is different. The compose file binds all three UIs to
`127.0.0.1` and adds the `host-gateway` mapping needed on Linux.

Prometheus retains seven days of data by default. The Alertmanager receiver is
intentionally empty in this baseline: alerts are visible in its UI. Wire a
webhook, Slack, email, or PagerDuty receiver into
[`observability/alertmanager.yml`](../observability/alertmanager.yml) for the
on-call path.

## Verifying the database-loss alert

The alert is verified automatically by
`test/integration/observability.test.ts`, which starts PostgreSQL, the API, and
a Prometheus container, stops PostgreSQL, and waits for
`WormholeDatabaseUnavailable` to enter the `firing` state. It is skipped when
Docker is unavailable.

To reproduce it manually:

```bash
# With the API, database, and observability stack running:
docker compose -f compose.yml -f compose.dev.yml stop db

# Within ~30 seconds:
curl -s localhost:3000/metrics | grep wormhole_database_up   # 0
curl -i localhost:3000/readyz                                 # 503
open http://localhost:9090/alerts                             # firing

docker compose -f compose.yml -f compose.dev.yml start db
# The gauge returns to 1 and the alert resolves automatically.
```

## Log and metric safety

- Request bodies, headers, and query strings are never logged.
- Short codes and user-submitted URLs do not become metric labels; routes are
  patterns such as `/shorten/:id`.
- Credentials, connection strings, and URL query/fragment data are redacted
  from every log field.
- The `/metrics` endpoint exposes internal operational data. Restrict it at the
  network or ingress layer in production.
- Change the Grafana admin password and the empty Alertmanager receiver before
  using this stack outside local development.
