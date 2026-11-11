<p align="center">
  <img src="./logo.svg" alt="wormhole logo" width="120" />
</p>

<h1 align="center">wormhole</h1>

<p align="center">
  A compact URL shortener API built with Node.js, Express 5, TypeScript, and PostgreSQL.
</p>

<p align="center">
  <img alt="Node.js 26.13+" src="https://img.shields.io/badge/node-%E2%89%A526.13.0-5FA04E?logo=node.js&logoColor=white" />
  <img alt="PostgreSQL 18.6" src="https://img.shields.io/badge/postgresql-18.6-4169E1?logo=postgresql&logoColor=white" />
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue" />
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#api-reference">API reference</a> ·
  <a href="#operations">Operations</a> ·
  <a href="#testing">Testing</a>
</p>

---

## Table of contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Running the service](#running-the-service)
- [API reference](#api-reference)
- [Database](#database)
- [Operations](#operations)
- [Observability](#observability)
- [Testing](#testing)
- [Scripts](#scripts)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Production notes](#production-notes)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Overview

wormhole is a RESTful URL shortener. It creates short, unique codes that map to a
stored destination URL, and it exposes endpoints for resolving, updating, deleting,
and measuring those links.

The service is intentionally small: Express handles HTTP, TypeScript provides the
type model, and PostgreSQL stores the data through raw SQL. There is no ORM and no
hidden persistence layer. Configuration is validated at boot, the database password
comes from a single mounted secret, and the process fails fast with an actionable
error when it cannot start correctly.

## Features

- **Short-link lifecycle** — create, resolve, update, delete, and inspect links.
- **Collision-safe codes** — 6-character codes from a 62-character alphabet, backed
  by a unique database constraint and bounded retries.
- **Atomic click counting** — resolving a link increments `access_count` in a
  single SQL statement, so concurrent requests do not lose updates.
- **Boot-time configuration validation** — every variable is parsed and checked
  before the HTTP server or database pool is created. Invalid configuration exits
  with status `1` and lists every problem at once.
- **Single source of truth for the database password** — the app and PostgreSQL
  read the same secret file via `POSTGRES_PASSWORD_FILE`.
- **Database resilience** — bounded exponential-backoff startup, idle-client error
  handling, and `503` responses with `Retry-After` for transient failures.
- **Graceful shutdown** — `SIGTERM`/`SIGINT` stop new connections, drain in-flight
  requests, close the pool, and exit cleanly.
- **Liveness and readiness probes** — `/healthz` never touches the database;
  `/readyz` checks it with a timeout and never leaks connection details.
- **Structured observability** — JSON logs with request IDs and redaction, RED
  metrics plus database pool gauges at `/metrics`, SLOs, alert rules, and a
  provisioned Grafana dashboard.
- **Strict TypeScript, ESM, native type stripping** — no build step for development.

## Architecture

```text
                       ┌──────────────────────────────────────────────┐
                       │                  Express 5                   │
  HTTP client  ──────► │ routes → middleware → controllers            │
                       │                    → services → queries      │
                       └───────────────────────┬──────────────────────┘
                                               │ pg.Pool
                                               ▼
                                      ┌─────────────────┐
                                      │  PostgreSQL 18  │
                                      └─────────────────┘
```

Each layer has one job:

| Layer | Responsibility |
| --- | --- |
| Routes | Map HTTP methods and paths to handlers. |
| Middleware | Parse JSON, validate required request fields, and handle errors. |
| Controllers | Translate between HTTP and the domain: status codes, response bodies. |
| Services | Enforce domain rules such as not-found errors and code-collision retries. |
| Queries | Execute parameterized SQL through the shared `pg.Pool`. |

`src/index.ts` is the composition root: it validates configuration, creates the
pool, waits for the database, registers routes and shutdown handlers, and starts
listening.

## Tech stack

| Component | Choice |
| --- | --- |
| Runtime | Node.js 26 LTS (minimum 26.13.0) |
| HTTP framework | Express 5.3 |
| Language | TypeScript 7, strict mode, ESM |
| Database | PostgreSQL 18.6 (pinned image digest in Compose) |
| Database driver | `pg` 8 with `pg.Pool`, raw parameterized SQL |
| Observability | JSON logs, Prometheus `/metrics`, alert rules, Grafana dashboard |
| Tests | Node.js built-in test runner (`node:test`) |
| Containerization | Docker Compose for PostgreSQL and the local observability stack |

## Requirements

- **Node.js 26.13.0 or newer.** The version is pinned by `.nvmrc` and enforced by
  `engines.node` plus `engine-strict=true` in `.npmrc`. Node 26 is the current LTS
  line; native TypeScript type stripping and `--env-file` are required.
- **npm** with the committed `package-lock.json`. Use `npm ci` for reproducible
  installs.
- **Docker Engine** for the integration test suite, and **Docker Compose v2** for
  the local PostgreSQL instance. PostgreSQL can also be provided externally.
- Free local ports: `3000` for the API and `5432` for PostgreSQL by default, both
  configurable. The optional observability stack uses `9090` (Prometheus), `9093`
  (Alertmanager), and `3001` (Grafana).

## Quick start

The containerized stack runs both PostgreSQL and the API:

```bash
# 1. Clone and create the local environment
git clone https://github.com/FK78/wormhole.git
cd wormhole
cp .env.example .env

# 2. Create the database password file (shared by the app and the container)
mkdir -p secrets
printf '%s' 'change-me' > secrets/postgres_password.txt
chmod 600 secrets/postgres_password.txt

# 3. Build and start PostgreSQL and the API
docker compose up -d --build
```

The one-shot `secret-init` service reads the password file as root and copies it
into a volume owned by UID 1000, the app's runtime user. The host file can stay
mode `600`, and the app never reads it directly.

Verify that the containers and database are healthy:

```bash
docker compose ps
curl -s http://localhost:3000/healthz
curl -s http://localhost:3000/readyz
```

Create a link:

```bash
curl -s -X POST http://localhost:3000/shorten \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.example.com/products/electronics/smartphones?utm_source=newsletter"}'
```

The schema in `db/schema.sql` is applied automatically the first time the
PostgreSQL data volume is initialized. If the volume already exists, the schema is
not re-applied; reset it with `docker compose down -v` (this destroys data) or
apply migrations manually.

### Local development with watch mode

To run the API on the host with `--watch` instead of in a container, complete the
[Quick start](#quick-start) environment steps first so `.env` exists and
`secrets/postgres_password.txt` contains the database password. Then:

```bash
nvm use                 # or install Node.js >= 26.13.0 manually
npm ci
docker compose -f compose.yml -f compose.dev.yml up -d db
docker compose -f compose.yml -f compose.dev.yml port db 5432
# 127.0.0.1:5432
npm run dev
```

The overlay publishes PostgreSQL on `127.0.0.1:${POSTGRES_PORT:-5432}` by
attaching the database to a project-scoped, non-internal `dev` network; the
`backend` network stays internal. Docker publishes ports only through a
non-internal network. `HOST=127.0.0.1` in `.env` matches the IPv4 loopback
binding, which matters on systems where `localhost` resolves to `::1` first.

Do not run it while the `app` container is publishing host port 3000; stop one or
set a different `WORMHOLE_PORT`. Verify the API with
`curl -s http://localhost:3000/readyz`.

## Configuration

Configuration is read from the process environment. The npm scripts load `.env`
with Node's `--env-file`, and variables already present in the environment take
precedence over values in the file.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `WORMHOLE_PORT` | No | `3000` | Port the HTTP server listens on (1–65535). |
| `SHUTDOWN_TIMEOUT_MS` | No | `10000` | Maximum time to drain in-flight requests before forcing exit (1–2147483647). |
| `DB_CONNECT_TIMEOUT_MS` | No | `5000` | Connection timeout for each `pg.Pool` connection attempt (1–2147483647). |
| `DB_HEALTH_CHECK_INTERVAL_MS` | No | `5000` | How often the database availability probe runs (1–2147483647). |
| `LOG_LEVEL` | No | `info` | Minimum log level: `debug`, `info`, `warn`, or `error`. |
| `POSTGRES_USER` | Yes | — | PostgreSQL username. |
| `POSTGRES_PASSWORD_FILE` | Yes | — | Path to a file containing the PostgreSQL password. |
| `POSTGRES_DB` | Yes | — | PostgreSQL database name. |
| `POSTGRES_PORT` | No | `5432` | PostgreSQL port (1–65535); also the host port published by `compose.dev.yml`. |
| `HOST` | No | `localhost` | PostgreSQL host. `.env.example` sets `127.0.0.1` to match the development overlay's IPv4 loopback binding. |
| `GIT_COMMIT` | No | `unknown` | Optional commit identifier surfaced by the health endpoints. Set it in your build or deployment pipeline. |

`POSTGRES_PASSWORD_FILE` is resolved relative to the process working directory when
the app reads it. Compose resolves its `secrets.postgres_password.file` path
relative to the Compose file, which is the repository root in the commands here.
The one-shot `secret-init` service copies that Docker secret into a volume and the
app reads `/run/secrets/postgres_password`, so the host file remains the single
source of truth.

### Validation behavior

`src/config.ts` validates the entire environment before any connection or socket is
created. It reports every problem in a single error and exits with status `1`:

```text
Invalid configuration:
  - POSTGRES_USER is required
  - POSTGRES_DB is required
  - POSTGRES_PASSWORD_FILE is required

See .env.example and README.md for the expected variables.
```

Rules:

- Missing or empty required variables are errors.
- Missing or empty optional variables use their defaults. An empty `POSTGRES_PORT`
  is treated as unset, not as `0`.
- Ports must be integers in `1–65535`. Timeouts must be positive integers no larger
  than `2147483647` (the `setTimeout` maximum). `LOG_LEVEL` must be one of the
  levels listed above.
- `POSTGRES_PASSWORD_FILE` must point to a readable, non-empty file. Trailing
  newlines are stripped the same way PostgreSQL's entrypoint strips them; other
  whitespace is preserved so the app and the container use identical bytes.
- `POSTGRES_PASSWORD` and `DATABASE_URL` are intentionally unsupported and cause
  startup to fail with a message directing you to the discrete variables and the
  password file.

### Changing the database password

PostgreSQL reads the password file only when it initializes a new data volume.
Editing `secrets/postgres_password.txt` after the database has started does **not**
change the password already stored in PostgreSQL; the app will then fail
authentication. Either update the role explicitly:

```bash
docker compose exec db \
  psql -U postgres -c "ALTER ROLE postgres WITH PASSWORD 'new-password';"
```

or recreate the development volume with `down -v` (destroys all data).

## Running the service

### Development

Run the API on the host with watch mode, with PostgreSQL from Compose:

```bash
docker compose -f compose.yml -f compose.dev.yml up -d db
npm run dev
```

The overlay publishes the database on `127.0.0.1:${POSTGRES_PORT:-5432}` through
a non-internal `dev` network while `backend` stays internal; the base stack
publishes no database port. `npm run dev` runs `src/index.ts` directly with
Node's type stripping and `--watch`, loading `.env` and restarting on file
changes. See the [Quick start](#quick-start) if `.env` or
`secrets/postgres_password.txt` is missing.

### Container image

`Dockerfile` is a multi-stage build: `npm ci` and `tsc` run in build stages, and
the runtime stage contains only production dependencies, `dist/`, and
`package.json`. The image runs as the unprivileged `node` user (UID 1000), exposes
port 3000, and starts with `node dist/index.js`.

```bash
docker build --tag wormhole:local .
```

`compose.yml` builds the same image for the `app` service. `docker compose up`
starts PostgreSQL and the API; `compose.dev.yml` is only needed when the API runs
on the host. The Node 26.13.0 base image is pinned by digest, so update `.nvmrc`,
`engines.node`, and the digest together.

### Production build

```bash
npm ci
npm run build          # tsc -> dist/
node dist/index.js     # configuration comes from the process environment
```

`npm start` is a convenience for environments that have a `.env` file:

```bash
npm start              # node --env-file .env dist/index.js
```

Run `npm run build` before omitting dev dependencies; TypeScript is a dev
dependency. For orchestrators, inject environment variables and secrets directly
and run `node dist/index.js` rather than relying on `.env`; this is also the
image's `CMD`.

### Local PostgreSQL

`compose.yml` defines the database and the API. The database is attached only to
the internal `backend` network, so the base stack never publishes PostgreSQL to
the host. The API joins `backend` for database traffic and a separate `edge`
bridge for its loopback-published port; Docker does not publish ports from an
internal-only network. A one-shot `secret-init` service copies the Docker secret
into a UID 1000-owned volume before the app starts, so the host file's owner and
mode do not have to match the container user.

Run the full stack with the base file:

```bash
docker compose up -d --build
```

`compose.dev.yml` is the host-development overlay. It publishes PostgreSQL on
`127.0.0.1:${POSTGRES_PORT:-5432}` and attaches the database to an additional
project-scoped, non-internal `dev` network. A separate network is required
because Docker publishes ports only through a non-internal network; flipping
`backend.internal` is unreliable for existing networks and would remove the
database's isolation. Use the overlay when the API runs on the host:

```bash
docker compose -f compose.yml -f compose.dev.yml up -d db
docker compose -f compose.yml -f compose.dev.yml port db 5432
# 127.0.0.1:5432
npm run dev
```

The full stack with the overlay also publishes the database, but the `app`
container then owns port 3000:

```bash
docker compose -f compose.yml -f compose.dev.yml up -d --build
```

The base file publishes the API only on `127.0.0.1:${WORMHOLE_PORT:-3000}`.
Change `WORMHOLE_PORT` in `.env` to move the API port and `POSTGRES_PORT` to move
the database port. If you used an older overlay, confirm the backend network was
reconciled with
`docker network inspect wormhole_backend --format '{{.Internal}}'` (it should
print `true`); if Compose reports the network is in use, run
`docker compose down` once (without `-v`) and start the stack again.

## API reference

Base URL: `http://localhost:3000` by default. All request and response bodies are
JSON; send `Content-Type: application/json` for `POST` and `PUT`. Timestamps are
ISO 8601 strings; `updatedAt` is `null` until the link is first updated.

| Method | Path | Description | Success |
| --- | --- | --- | --- |
| `POST` | `/shorten` | Create a short link. | `201 Created` |
| `GET` | `/shorten/:id` | Resolve a short code and increment its access count. | `200 OK` |
| `PUT` | `/shorten/:id` | Change the destination URL. | `200 OK` |
| `DELETE` | `/shorten/:id` | Delete a short link. | `204 No Content` |
| `GET` | `/shorten/:id/stats` | Read link metadata and access count. | `200 OK` |
| `GET` | `/healthz` | Liveness probe. Never touches the database. | `200 OK` |
| `GET` | `/readyz` | Readiness probe. Checks the database. | `200 OK` / `503` |
| `GET` | `/metrics` | Prometheus metrics for RED signals and the database pool. | `200 OK` |

Short codes are six characters from `0-9`, `a-z`, and `A-Z`. Creation retries up to
five times if the generated code collides with an existing row.

### Create a short link

```http
POST /shorten
Content-Type: application/json

{
  "url": "https://www.example.com/some/long/url"
}
```

`url` is required and must be a non-empty string. The API stores the value as
provided; it does not validate URL syntax or restrict destination schemes.

**Response — `201 Created`**

```json
{
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "url": "https://www.example.com/some/long/url",
  "shortCode": "aB3xY9",
  "createdAt": "2026-11-11T09:00:00.000Z",
  "updatedAt": null
}
```

`updatedAt` is `null` until the link is updated. Responses for resolving and
updating use the same shape; the stats endpoint adds `accessCount`.

**Errors**

| Status | Body | Cause |
| --- | --- | --- |
| `400` | `{"error":"Please enter all required fields"}` | `url` is missing or empty. |
| `500` | `{"error":"Internal Server Error"}` | Unexpected server error. |
| `503` | `{"error":"Service temporarily unavailable"}` | Transient database failure. Includes `Retry-After: 1`. |

### Resolve a short link

```http
GET /shorten/aB3xY9
```

Returns the stored link and atomically increments `access_count`. The increment is
not included in this response; use the stats endpoint to read it.

**Response — `200 OK`**

```json
{
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "url": "https://www.example.com/some/long/url",
  "shortCode": "aB3xY9",
  "createdAt": "2026-11-11T09:00:00.000Z",
  "updatedAt": null
}
```

**Errors:** `404` when the short code does not exist, plus `500`/`503` as above.

### Update a short link

```http
PUT /shorten/aB3xY9
Content-Type: application/json

{
  "url": "https://www.example.com/some/updated/url"
}
```

**Response — `200 OK`**

```json
{
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "url": "https://www.example.com/some/updated/url",
  "shortCode": "aB3xY9",
  "createdAt": "2026-11-11T09:00:00.000Z",
  "updatedAt": "2026-11-11T10:15:00.000Z"
}
```

**Errors:** `400` when `url` is missing or empty, `404` when the short code does not
exist.

### Delete a short link

```http
DELETE /shorten/aB3xY9
```

**Response — `204 No Content`** with an empty body.

**Errors:** `404` when the short code does not exist.

### Read link statistics

```http
GET /shorten/aB3xY9/stats
```

Reading statistics does not increment the counter.

**Response — `200 OK`**

```json
{
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "url": "https://www.example.com/some/long/url",
  "shortCode": "aB3xY9",
  "createdAt": "2026-11-11T09:00:00.000Z",
  "updatedAt": null,
  "accessCount": 42
}
```

**Errors:** `404` when the short code does not exist.

### Health and readiness

`GET /healthz` returns liveness immediately and never queries the database:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "commit": "unknown",
  "uptimeSeconds": 42
}
```

`GET /readyz` runs `SELECT 1` with a one-second timeout:

```json
{
  "status": "ready",
  "version": "1.0.0",
  "commit": "unknown",
  "uptimeSeconds": 42,
  "checks": { "database": "ok" }
}
```

When the database is unavailable or the check times out, it returns `503 Service
Unavailable` with `Retry-After: 1`:

```json
{
  "status": "unavailable",
  "version": "1.0.0",
  "commit": "unknown",
  "uptimeSeconds": 42,
  "checks": { "database": "unavailable" }
}
```

Both endpoints send `Cache-Control: no-store`. `version` comes from `package.json`;
`commit` comes from `GIT_COMMIT` or defaults to `"unknown"`. The readiness response
never includes connection strings, credentials, or stack traces.

### Error responses

| Status | Meaning |
| --- | --- |
| `400` | A required request field is missing or empty. |
| `404` | The short code or route does not exist. |
| `500` | An unexpected error occurred. Details are logged server-side, not returned. |
| `503` | A transient database failure occurred. Retry after the `Retry-After` delay. |

Unknown routes return `404` with `{"error":"Route not found"}`. Unknown short codes
return `404` with `{"error":"Failed to find URL"}`.

## Database

The schema is defined in [`db/schema.sql`](./db/schema.sql):

```sql
CREATE TABLE urls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT NOT NULL,
    short_code TEXT UNIQUE NOT NULL,
    access_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ
);
```

- `short_code` has a unique constraint, which is the source of truth for collision
  detection. The application retries generation when the insert violates it.
- `created_at` defaults to `NOW()`. `updated_at` is `NULL` until the first update.
- Resolving a link executes `UPDATE ... SET access_count = access_count + 1 ...
  RETURNING`, so the read and increment are atomic.
- There is no migration framework. `db/schema.sql` is mounted into
  `/docker-entrypoint-initdb.d/` and runs only when PostgreSQL initializes a fresh
  volume. Treat schema changes as explicit migrations in environments where data
  must be preserved.

## Operations

### Health probes

| Probe | Purpose | Behavior |
| --- | --- | --- |
| `/healthz` | Liveness | Returns `200` while the process is running; never touches the database. Use it for process restarts. |
| `/readyz` | Readiness | Returns `200` only when `SELECT 1` succeeds within one second; `503` otherwise. Use it for traffic routing. |

Readiness is evaluated per request, so the service recovers automatically when the
database returns. Startup itself waits for the database before listening, so a
readiness probe will not succeed until the initial connection and `SELECT 1`
complete.

### Startup and database resilience

- At boot, `waitForDatabase()` retries `SELECT 1` up to 10 times with exponential
  backoff (250 ms to 5 s, with jitter).
- `pg.Pool` removes broken idle clients and creates new ones on demand. Idle-client
  errors are logged and do not crash the process.
- Transient database errors return `503` with `Retry-After: 1`. Writes are not
  retried automatically because a connection can fail after a write has committed.
  Clients should decide whether a retry is safe.
- Each connection attempt is bounded by `DB_CONNECT_TIMEOUT_MS`.

### Graceful shutdown

On `SIGTERM` or `SIGINT`, the service:

1. Stops accepting new connections.
2. Waits for in-flight requests to complete, up to `SHUTDOWN_TIMEOUT_MS`.
3. Closes idle keep-alive sockets.
4. Closes the database pool.
5. Exits with status `0` on success, or `1` if draining or pool shutdown fails.

If the timeout expires, remaining connections are force-closed and the process
exits with status `1`. A second signal forces an immediate exit.

Set the orchestrator's termination grace period to at least
`SHUTDOWN_TIMEOUT_MS` plus a small buffer so the process can finish draining.

### Logging

Every log line is a single JSON object written to stdout (`debug`, `info`) or stderr
(`warn`, `error`):

```json
{"timestamp":"2026-11-11T12:34:56.789Z","level":"info","service":"wormhole","message":"HTTP request completed","requestId":"demo-request-1","method":"GET","route":"/shorten/:id","status":200,"durationMs":1.234}
```

- Fields are `timestamp`, `level`, `service`, `message`, and event-specific
  context. `LOG_LEVEL` controls verbosity.
- Send `X-Request-ID` or let the server generate one. It is echoed in the response
  and attached to every access, error, and database log line for that request.
- Access logs record method, bounded route pattern, status, latency, and request
  ID. `5xx` is logged at `error`, `4xx` at `warn`; requests to `/healthz`,
  `/readyz`, and `/metrics` are excluded.
- Error logs include `name`, `message`, `stack`, and `code`, but never request
  bodies, headers, query strings, or pg's row-level fields.
- Credentials, connection strings, and URL query/fragment data are redacted at
  every nesting level.

Collect stdout/stderr with your platform's log pipeline. The complete schema and
redaction rules are in [docs/observability.md](docs/observability.md).

## Observability

### Metrics

`GET /metrics` exposes Prometheus text format:

| Metric | Type | Meaning |
| --- | --- | --- |
| `wormhole_http_requests_total{method,route,status}` | counter | Request count and error rate. |
| `wormhole_http_request_duration_seconds{method,route}` | histogram | Request latency (p50/p95/p99). |
| `wormhole_database_up` | gauge | Last database health check (`1`/`0`). |
| `wormhole_database_health_checks_total{status}` | counter | Database probe outcomes. |
| `wormhole_db_pool_total_connections` | gauge | Pool connections in use or idle. |
| `wormhole_db_pool_idle_connections` | gauge | Idle pool connections. |
| `wormhole_db_pool_waiting_clients` | gauge | Requests waiting for a connection. |
| `wormhole_db_pool_max_connections` | gauge | Pool limit. |
| `wormhole_build_info{version,commit}` | gauge | Build identity; always `1`. |

Route labels use patterns such as `/shorten/:id`, never raw short codes, so metric
cardinality stays bounded. Health probes and `/metrics` scrapes are excluded from
RED metrics. A background probe updates the database gauge every
`DB_HEALTH_CHECK_INTERVAL_MS`, independent of HTTP traffic. The endpoint is
unauthenticated; restrict it at the network or ingress layer in production.

### SLOs and alerts

Targets over a rolling 30-day window: 99.9% availability (0.1% error ratio),
p95 latency at or below 300 ms, and p99 latency at or below 1 s. Alert rules in
[`observability/alerts.yml`](observability/alerts.yml) cover target down,
database unavailability, high error rate, p95/p99 latency, and pool
saturation/waiters. `WormholeTargetDown` fires when Prometheus cannot scrape the
API, which also covers process death. `WormholeDatabaseUnavailable` fires 30
seconds after `wormhole_database_up` drops to `0`; when the process is gone that
metric is absent rather than zero, so the target alert is the one that catches
it.

### Local Prometheus, Alertmanager, and Grafana

For the host-run API (`npm run dev`), the base observability stack scrapes
`host.docker.internal:3000`:

```bash
docker compose -f compose.observability.yml up -d
```

For the containerized API, start the app stack first, then add the container
overlay. Prometheus joins `wormhole_edge` and scrapes `app:3000` directly:

```bash
docker compose up -d --build
docker compose -f compose.observability.yml -f compose.observability.container.yml up -d
```

| Service | URL |
| --- | --- |
| Prometheus | http://localhost:9090 |
| Alertmanager | http://localhost:9093 |
| Grafana | http://localhost:3001 (`admin`/`admin` by default) |

The overlay requires the `wormhole_edge` network, which the app stack creates.
Edit [`observability/prometheus.yml`](observability/prometheus.yml) if
`WORMHOLE_PORT` differs for the host-run API; the container overlay always uses
the internal port 3000. The Grafana dashboard is provisioned automatically. To
verify the database-loss alert, run the API and database, then:

```bash
docker compose stop db
# wormhole_database_up becomes 0; WormholeDatabaseUnavailable fires after ~30s.
docker compose start db
```

Detailed runbooks, SLO queries, and the full log schema are in
[docs/observability.md](docs/observability.md).

## Testing

```bash
npm test               # unit + integration
npm run test:unit      # fast, no database required
npm run test:integration
```

- **Unit tests** cover configuration validation (including missing, empty, and
  malformed values), the entrypoint's fail-fast behavior, health endpoints, error
  mapping, retry helpers, structured logging and redaction, request-ID correlation,
  access logs, metric exposition, and the database monitor. They use Node's built-in
  test runner and mock `pg.Pool` where needed.
- **Integration tests** require Docker and, for the Compose overlay suite, Docker
  Compose. They start disposable `postgres:18.6` containers and verify PostgreSQL
  restart recovery, startup backoff, graceful shutdown with an in-flight request,
  liveness/readiness during an outage, and automatic recovery. The Compose
  development-overlay suite starts a disposable project, verifies the base stack
  leaves PostgreSQL unpublished and `backend` internal, then applies
  `compose.dev.yml` and verifies the port is reachable on `127.0.0.1` while
  `backend` remains internal. The observability suite also starts a
  `prom/prometheus` container to verify that simulated database loss fires
  `WormholeDatabaseUnavailable`, and checks that logs and metrics never expose
  credentials or query secrets. They create temporary password files and skip
  cleanly when Docker (or Compose, for the overlay suite) is unavailable.

No coverage tooling or CI test pipeline is configured; run the suite locally before
opening a pull request. The `Container CI` workflow builds the image, records a
CycloneDX SBOM artifact with Syft, and scans it with Grype. It fails on fixable
HIGH/CRITICAL findings and uploads SARIF to code scanning.

## Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `npm run dev` | `node --env-file .env --watch src/index.ts` | Development server with reload and native TypeScript execution. |
| `npm run build` | `tsc` | Type-check and emit JavaScript to `dist/`. |
| `npm start` | `node --env-file .env dist/index.js` | Run the compiled build with `.env`. |
| `npm test` | `node --test "test/**/*.test.ts"` | Run all tests. |
| `npm run test:unit` | `node --test "test/unit/**/*.test.ts"` | Run unit tests only. |
| `npm run test:integration` | `node --test --test-concurrency=1 "test/integration/**/*.test.ts"` | Run Docker-backed integration tests serially. |

## Project structure

```text
wormhole/
├── .github/
│   └── workflows/
│       └── ci.yml               # image build, SBOM, Grype scan
├── src/
│   ├── index.ts                 # composition root: config, pool, routes, shutdown
│   ├── config.ts                # environment schema and validation
│   ├── controllers/
│   │   ├── health.controller.ts
│   │   └── url.controller.ts
│   ├── db/
│   │   ├── db.ts                # pool lifecycle and database readiness
│   │   └── retry.ts             # transient-error detection and backoff
│   ├── errors/
│   │   └── AppError.ts
│   ├── middleware/
│   │   ├── errorHandler.ts      # AppError, 500, and transient-DB 503 mapping
│   │   ├── httpObservability.ts # access logs and RED metrics
│   │   ├── requestContext.ts    # request IDs and async log context
│   │   └── validate.ts          # required-field validation
│   ├── observability/
│   │   ├── http.ts              # bounded route labels
│   │   ├── logger.ts            # JSON logger and redaction
│   │   └── metrics.ts           # Prometheus registry and exposition
│   ├── queries/
│   │   └── url.queries.ts       # parameterized SQL
│   ├── routes/
│   │   ├── health.router.ts
│   │   ├── metrics.router.ts
│   │   └── url.router.ts
│   ├── services/
│   │   ├── databaseMonitor.ts   # background availability probe
│   │   ├── health.service.ts    # readiness query with timeout
│   │   └── url.service.ts       # domain rules and collision retries
│   └── utils/
│       ├── buildInfo.ts         # version and commit metadata
│       └── generateRandomCode.ts
├── db/
│   └── schema.sql
├── docs/
│   └── observability.md         # logs, metrics, SLOs, alerts, runbooks
├── observability/
│   ├── alerts.yml               # Prometheus alert rules
│   ├── alertmanager.yml
│   ├── prometheus.yml           # host-run API scrape config
│   ├── prometheus.container.yml # container-mode scrape config
│   └── grafana/                 # provisioned datasource and dashboard
├── test/
│   ├── integration/
│   │   ├── compose-dev.test.ts
│   │   ├── db-lifecycle.test.ts
│   │   ├── health-readiness.test.ts
│   │   └── observability.test.ts
│   └── unit/
│       ├── config.test.ts
│       ├── databaseMonitor.test.ts
│       ├── errorHandler.test.ts
│       ├── health.test.ts
│       ├── httpObservability.test.ts
│       ├── logger.test.ts
│       ├── metrics.test.ts
│       └── retry.test.ts
├── .dockerignore
├── .env.example
├── .npmrc
├── .nvmrc
├── Dockerfile                   # multi-stage production image
├── compose.yml                  # PostgreSQL, API, and secret init
├── compose.dev.yml              # host DB port and dev network overlay
├── compose.observability.yml    # Prometheus, Alertmanager, Grafana
├── compose.observability.container.yml # container-mode scrape overlay
├── package.json
├── package-lock.json
├── tsconfig.json
└── logo.svg
```

## Troubleshooting

### `Invalid configuration: ...`

The process refused to start because one or more variables are missing, empty, or
malformed. Fix `.env` (or the process environment). The error lists every problem,
so a single restart can resolve all of them. A missing password file is reported
with the resolved path and operating-system error code.

### `password authentication failed for user "postgres"` (`28P01`)

The app and PostgreSQL are not using the same password. Confirm that
`POSTGRES_PASSWORD_FILE` points to the file mounted by Compose and that the file
contains the password PostgreSQL was initialized with. If you changed the file after
the data volume was created, see [Changing the database
password](#changing-the-database-password).

### `connect ECONNREFUSED 127.0.0.1:5432`

PostgreSQL is not running, is not published on the expected host port, or `HOST` /
`POSTGRES_PORT` are wrong. For host-side development, start only the database with
the development overlay and confirm the mapping:

```bash
docker compose -f compose.yml -f compose.dev.yml up -d db
docker compose -f compose.yml -f compose.dev.yml port db 5432
# 127.0.0.1:5432
docker compose ps
```

If `port` prints nothing (or `:0`), the overlay was not applied. If it prints a
different port, update `POSTGRES_PORT` in `.env`; Compose and `npm run dev` read
the same variable. The port binds to IPv4 loopback, so keep `HOST=127.0.0.1` in
`.env` if `localhost` resolves to `::1` first. To run the full containerized
stack instead (this occupies host port 3000):

```bash
docker compose up -d --build
```

### `listen EADDRINUSE: address already in use`

Another process owns `WORMHOLE_PORT`. Stop it or set a different port in `.env`.

### `node: .env: not found`

`npm run dev` and `npm start` load `.env`. Run `cp .env.example .env`, or run
`node dist/index.js` with environment variables supplied by your platform.

### `POSTGRES_PASSWORD_FILE: cannot read`

The app reads the copy created by the one-shot `secret-init` service, not the
host file directly. Check `docker compose logs secret-init`; the host file must
exist and be readable by that container (it runs as root). Then check the app
logs for the resolved path.

### Integration tests are skipped

Docker is not available to the test process (or Docker Compose is unavailable for
the Compose overlay suite). Start Docker and verify with `docker info` and
`docker compose version`. Unit tests do not require Docker.

## Production notes

### Security

- **No authentication or authorization** is implemented. Do not expose the API
  directly to the public internet; place it behind an API gateway, reverse proxy, or
  service mesh that handles authentication, authorization, and TLS termination.
- **No rate limiting or abuse protection** is implemented. Add quotas at the edge,
  especially for `POST /shorten`.
- **Destination URLs are stored without syntax validation or scheme restrictions.**
  Add validation if untrusted clients can submit links.
- **Secrets stay out of source control.** `secrets/` and `.env` are gitignored. A
  one-shot `secret-init` service reads the password file as root, copies it into a
  volume owned by UID 1000, and the app reads only that copy. Keep the host file
  mode `600`; do not bake it into an image.
- **The Compose services are hardened** with `cap_drop: ALL`, `no-new-privileges`,
  a read-only root filesystem for the API, and an internal network for database
  traffic. The API joins a second `edge` bridge only because Docker cannot publish
  ports from an internal-only network. Keep the loopback port binding unless a
  reverse proxy owns ingress.
- **Dependencies are pinned** to exact versions in `package.json` and the lockfile;
  `engine-strict=true` prevents installing on an unsupported Node release.
- **`/metrics` is unauthenticated.** Keep it on a private interface or restrict it
  at the ingress/load balancer. Logs redact credentials and query data, but log
  retention and access controls still belong to your logging platform.

### Deployment checklist

- [ ] Build the image with `docker build` in CI or an image builder; the `Container
      CI` workflow builds it and scans it with Grype.
- [ ] Run the image as the non-root `node` user and keep the root filesystem
      read-only unless the workload needs writable paths.
- [ ] Review the uploaded SBOM and Grype SARIF results; do not ship fixable
      HIGH/CRITICAL findings.
- [ ] Provide configuration through the process environment; avoid shipping `.env`.
- [ ] Provide `POSTGRES_PASSWORD_FILE` as a mounted secret; the Compose
      `secret-init` service copies it to a UID 1000-owned volume for the app.
- [ ] Point `HOST` and `POSTGRES_PORT` at a private database endpoint.
- [ ] Configure `/healthz` as the liveness probe and `/readyz` as the readiness
      probe.
- [ ] Set the termination grace period to at least `SHUTDOWN_TIMEOUT_MS`.
- [ ] Set `GIT_COMMIT` so health responses and `wormhole_build_info` identify the
      deployed revision.
- [ ] Collect stdout/stderr in your logging platform; parse it as JSON.
- [ ] Scrape `/metrics` and load `observability/alerts.yml`; send alerts through
      Alertmanager to your on-call channel.
- [ ] Apply schema changes with an explicit migration process; the initdb script
      only runs on a fresh volume.
- [ ] Back up PostgreSQL, and test restores, independently of this service.

### Scaling

The service is stateless and can run as multiple replicas behind a load balancer.
Short-code uniqueness is enforced by the database, so concurrent creation across
replicas is safe. Each Node process creates its own `pg.Pool`; size PostgreSQL's
`max_connections` for the total number of processes and replicas. Resolving a link
performs a write to increment `access_count`, so read-heavy traffic still produces
database writes.

## Known limitations

- No authentication, authorization, rate limiting, or abuse protection.
- No custom aliases, link expiration, listing/search, or click-history analytics;
  statistics expose only the total `access_count`.
- Destination URL syntax is not validated. Any non-empty string is stored and
  returned.
- No migration framework; `db/schema.sql` is initialization-only.
- Metrics are pull-based Prometheus only; there is no OTLP exporter or distributed
  tracing.
- The bundled Alertmanager receiver is intentionally empty and must be wired to a
  real notification channel before production use.
- Write operations are not automatically retried after transient database failures,
  because the write may already have committed.

## Contributing

1. Fork the repository and create a focused branch.
2. Install with `npm ci` and use the Node version from `.nvmrc`.
3. Make the change with tests. Keep TypeScript strict, ESM imports, and raw
   parameterized SQL.
4. Run `npm run build` and `npm test`; Docker is required for integration tests.
5. Update this README when configuration, API behavior, or operations change.
6. Open a pull request describing the problem, the approach, and the verification
   performed.

## License

[MIT](./LICENSE) © 2026 Fahad

## Acknowledgements

Built as a solution to the [URL Shortening Service](https://roadmap.sh/projects/url-shortening-service)
project on [roadmap.sh](https://roadmap.sh).
