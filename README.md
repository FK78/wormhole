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

| Method   | Route                 | What it does                       |
| -------- | --------------------- | ---------------------------------- |
| `POST`   | `/shorten`            | Compress a URL into oblivion       |
| `GET`    | `/shorten/:id`        | Retrieve the original URL          |
| `PUT`    | `/shorten/:id`        | Point the shortcode somewhere else |
| `DELETE` | `/shorten/:id`        | Erase it from existence            |
| `GET`    | `/shorten/:id/stats`  | See how popular your link is       |

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

> Swap `localhost:3000` for whatever `WORMHOLE_PORT` you set in `.env`.

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

## Testing

```bash
npm test               # unit + integration tests
npm run test:unit      # fast tests, no database required
npm run test:integration
```

The integration test starts its own `postgres:18.6` container with a fixed, dynamic host port, restarts PostgreSQL while the API is serving, checks that the process survives and recovers, and verifies graceful shutdown with an in-flight request. It skips cleanly when Docker is unavailable.

## Getting Started

```bash
git clone https://github.com/FK78/wormhole.git
cd wormhole
npm install
```

Set up your environment:

```bash
cp .env.example .env
mkdir -p secrets
printf '%s' 'change-me' > secrets/postgres_password.txt
chmod 600 secrets/postgres_password.txt
```

The database password lives in `secrets/postgres_password.txt`. The app reads it through `POSTGRES_PASSWORD_FILE`, and `compose.yml` mounts the same file into the PostgreSQL container - so there is exactly one place to change it. The file is gitignored, so every checkout needs its own. Relative paths are resolved from the directory you start the app in (the repository root in the commands below).

`.env.example` looks like this - adjust values to match your setup:

```bash
WORMHOLE_PORT=3000
SHUTDOWN_TIMEOUT_MS=10000
DB_CONNECT_TIMEOUT_MS=5000
POSTGRES_USER=postgres
POSTGRES_PASSWORD_FILE=./secrets/postgres_password.txt
POSTGRES_DB=wormhole
POSTGRES_PORT=5432
HOST=localhost
```

| Variable                 | Required | Default     | Description                                    |
| ------------------------ | -------- | ----------- | ---------------------------------------------- |
| `WORMHOLE_PORT`          | no       | `3000`      | Port the Express server listens on             |
| `SHUTDOWN_TIMEOUT_MS`    | no       | `10000`     | Max time to drain requests before forcing exit |
| `DB_CONNECT_TIMEOUT_MS`  | no       | `5000`      | Max time to wait for a database connection     |
| `POSTGRES_USER`          | yes      | -           | PostgreSQL username                            |
| `POSTGRES_PASSWORD_FILE` | yes      | -           | File containing the PostgreSQL password        |
| `POSTGRES_DB`            | yes      | -           | PostgreSQL database name                       |
| `POSTGRES_PORT`          | no       | `5432`      | PostgreSQL port                                |
| `HOST`                   | no       | `localhost` | Database host                                  |

Configuration is validated at startup. Missing or empty required values, malformed ports and timeouts, an unreadable or empty password file, and the unsupported `DATABASE_URL`/`POSTGRES_PASSWORD` variables all stop the process with exit code `1` and list every problem. Optional variables left empty fall back to their defaults.

Start the database:

```bash
docker compose -f compose.yml -f compose.dev.yml up -d
```

`db/schema.sql` is mounted into `/docker-entrypoint-initdb.d/`, so Postgres applies it automatically the first time the volume is created. If the volume already exists, reset it before starting again:

```bash
docker compose -f compose.yml -f compose.dev.yml down -v
```

Start the server:

```bash
npm run dev
```

## Project Structure

```
wormhole/
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── routes/
│   │   └── url.router.ts
│   ├── controllers/
│   │   └── url.controller.ts
│   ├── services/
│   │   └── url.service.ts
│   ├── queries/
│   │   └── url.queries.ts
│   ├── middleware/
│   │   ├── errorHandler.ts
│   │   └── validate.ts
│   ├── errors/
│   │   └── AppError.ts
│   ├── utils/
│   │   └── generateRandomCode.ts
│   └── db/
│       ├── db.ts
│       └── retry.ts
├── db/
│   └── schema.sql
├── test/
│   ├── integration/
│   │   └── db-lifecycle.test.ts
│   └── unit/
│       ├── config.test.ts
│       ├── errorHandler.test.ts
│       └── retry.test.ts
├── .env.example
├── .nvmrc
├── compose.yml
├── compose.dev.yml
└── tsconfig.json
```

## Requirements

- Node.js 26 LTS (see `.nvmrc`); the minimum supported release is 26.13.0, which the app needs for native TypeScript type stripping and `--env-file`
- Docker (for PostgreSQL)
- Long URLs that need shortening (shouldn't be hard to find)

## Credit

Built as a solution to the [URL Shortening Service](https://roadmap.sh/projects/url-shortening-service) project on roadmap.sh.

## License

MIT - shorten it, fork it, wormhole it.
