<p align="center">
  <img src="./logo.svg" alt="wormhole logo" width="150" />
</p>

<h1 align="center">wormhole</h1>

<p align="center">
  <em>A URL shortener for people who think life's too short for long links.</em>
</p>

<p align="center">
  RESTful API that shrinks URLs, tracks clicks, and judges nothing.
</p>

---

## Why?

Because `https://www.example.com/products/categories/electronics/smartphones/2026/summer-sale?utm_source=newsletter&utm_medium=email&utm_campaign=july` deserves better.

## Tech Stack

- **Node.js** + **Express 5** + **TypeScript**
- **PostgreSQL** - running in Docker
- **pg** - raw SQL, no ORM
- No auth - this one's open season

## Endpoints

| Method   | Route                 | What it does                          |
| -------- | --------------------- | ------------------------------------- |
| `POST`   | `/shorten`            | Compress a URL into oblivion          |
| `GET`    | `/shorten/:id`        | Retrieve the original URL             |
| `PUT`    | `/shorten/:id`        | Point the shortcode somewhere else    |
| `DELETE` | `/shorten/:id`        | Erase it from existence               |
| `GET`    | `/shorten/:id/stats`  | See how popular your link is          |
| `GET`    | `/healthz`            | Liveness probe - never touches the DB |
| `GET`    | `/readyz`             | Readiness probe - verifies the DB     |

## Usage

```bash
# Create a short URL
curl -X POST http://localhost:3000/shorten \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.example.com/some/long/url"}'

# Retrieve the original URL
curl http://localhost:3000/shorten/abc123

# Point the shortcode somewhere else
curl -X PUT http://localhost:3000/shorten/abc123 \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.example.com/some/updated/url"}'

# Erase it from existence
curl -X DELETE http://localhost:3000/shorten/abc123

# See how popular your link is
curl http://localhost:3000/shorten/abc123/stats
```

> Swap `localhost:3000` for whatever `PORT` you set in `.env`.

## Response Examples

**Create:**

```json
{
  "id": "1",
  "url": "https://www.example.com/some/long/url",
  "shortCode": "abc123",
  "createdAt": "2026-07-21T12:00:00Z",
  "updatedAt": "2026-07-21T12:00:00Z"
}
```

**Stats:**

```json
{
  "id": "1",
  "url": "https://www.example.com/some/long/url",
  "shortCode": "abc123",
  "createdAt": "2026-07-21T12:00:00Z",
  "updatedAt": "2026-07-21T12:00:00Z",
  "accessCount": 42
}
```

## Status Codes

| Code  | Meaning                             |
| ----- | ----------------------------------- |
| `200` | Here's your link                    |
| `201` | Shortened. You're welcome.          |
| `204` | Deleted. Into the void.             |
| `400` | That's not a valid URL. Try again.  |
| `404` | Shortcode doesn't exist. Never did. |
| `500` | Something broke on our end.         |
| `503` | Database is temporarily unavailable. Retry shortly. |

## Database Resilience

- Idle pool clients can be terminated by PostgreSQL restarts. Those errors are logged, the broken client is removed, and `pg.Pool` opens a new connection on the next request.
- Startup waits for the database with bounded exponential backoff (10 attempts, 250ms–5s delays).
- Transient database failures return `503` with a `Retry-After` header. Writes are not automatically retried, because a connection can fail after a write has already committed.
- `SIGTERM` and `SIGINT` stop accepting new connections, drain in-flight requests for up to `SHUTDOWN_TIMEOUT_MS`, close the pool, then exit. If the deadline is reached, remaining connections are force-closed and the process exits with code `1`.

## Health Checks

`GET /healthz` is a **liveness** probe: it returns `200` as long as the process is running and never touches the database. Point process restarts at this endpoint, not traffic routing.

`GET /readyz` is a **readiness** probe: it runs `SELECT 1` with a 1-second timeout. It returns `200` when the database answers and `503` when it does not. Readiness is checked on every request, so it recovers automatically once the database is back - no restart needed. Point load balancer/orchestrator traffic routing at this endpoint.

```bash
curl -i http://localhost:3000/healthz
curl -i http://localhost:3000/readyz
```

Healthy response:

```json
{
  "status": "ready",
  "version": "1.0.0",
  "commit": "unknown",
  "uptimeSeconds": 42,
  "checks": { "database": "ok" }
}
```

Database unavailable (`503` with `Retry-After: 1`):

```json
{
  "status": "unavailable",
  "version": "1.0.0",
  "commit": "unknown",
  "uptimeSeconds": 42,
  "checks": { "database": "unavailable" }
}
```

`version` comes from `package.json`. `commit` comes from the optional `GIT_COMMIT` environment variable (set it at build time, for example with the git SHA) and is `"unknown"` when unset. Responses never include connection strings, credentials, or stack traces, and both endpoints send `Cache-Control: no-store`.

## Testing

```bash
npm test               # unit + integration tests
npm run test:unit      # fast tests, no database required
npm run test:integration
```

Unit tests use Node's built-in test runner and mock the `pg.Pool`. The integration tests start their own `postgres:18.6` containers with fixed, dynamic host ports: one restarts PostgreSQL while the API is serving to verify the process survives and recovers, and checks graceful shutdown with an in-flight request; the other verifies both health endpoints while the database is up, stops the container to check that `/readyz` returns `503` while `/healthz` stays `200`, then restarts it to verify automatic recovery. Both skip cleanly when Docker is unavailable.

## Getting Started

```bash
git clone https://github.com/FK78/wormhole.git
cd wormhole
npm install
```

Set up your environment:

```bash
cp .env.example .env
```

`.env.example` looks like this - adjust values to match your setup:

```bash
WORMHOLE_PORT=3000
SHUTDOWN_TIMEOUT_MS=10000
DB_CONNECT_TIMEOUT_MS=5000
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=wormhole
POSTGRES_PORT=5432
HOST=localhost
```

| Variable                | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `WORMHOLE_PORT`         | Port the Express server listens on             |
| `SHUTDOWN_TIMEOUT_MS`   | Max time to drain requests before forcing exit |
| `DB_CONNECT_TIMEOUT_MS` | Max time to wait for a database connection     |
| `POSTGRES_USER`         | PostgreSQL username                            |
| `POSTGRES_PASSWORD`     | PostgreSQL password                            |
| `POSTGRES_DB`           | PostgreSQL database name                       |
| `POSTGRES_PORT`         | PostgreSQL port                                |
| `HOST`                  | Database host                                  |

Start the database:

```bash
docker compose up -d
```

Create the tables:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

> **Tip:** you can skip this manual step by mounting `db/schema.sql` into `/docker-entrypoint-initdb.d/` in `compose.yml` - Postgres runs any `.sql` files there automatically on first boot. Just note it only fires on a fresh volume, so if you've already started the container once, run `docker compose down -v` first to reset it.

Start the server:

```bash
npm run dev
```

## Project Structure

```
wormhole/
├── src/
│   ├── index.ts
│   ├── routes/
│   │   ├── health.router.ts
│   │   └── url.router.ts
│   ├── controllers/
│   │   ├── health.controller.ts
│   │   └── url.controller.ts
│   ├── services/
│   │   ├── health.service.ts
│   │   └── url.service.ts
│   ├── queries/
│   │   └── url.queries.ts
│   ├── middleware/
│   │   ├── errorHandler.ts
│   │   └── validate.ts
│   ├── errors/
│   │   └── AppError.ts
│   ├── utils/
│   │   ├── buildInfo.ts
│   │   └── generateRandomCode.ts
│   └── db/
│       ├── db.ts
│       └── retry.ts
├── test/
│   ├── integration/
│   │   ├── db-lifecycle.test.ts
│   │   └── health-readiness.test.ts
│   └── unit/
│       ├── errorHandler.test.ts
│       ├── health.test.ts
│       └── retry.test.ts
├── db/
│   └── schema.sql
├── .env.example
├── compose.yml
├── compose.dev.yml
└── tsconfig.json
```

## Requirements

- Node.js 22.18+ (native TypeScript type stripping)
- Docker (for PostgreSQL)
- Long URLs that need shortening (shouldn't be hard to find)

## Credit

Built as a solution to the [URL Shortening Service](https://roadmap.sh/projects/url-shortening-service) project on roadmap.sh.

## License

MIT - shorten it, fork it, wormhole it.
