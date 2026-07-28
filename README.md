<p align="center">
  <img src="./logo.svg" alt="Wormhole" width="150" />
</p>

<h1 align="center">Wormhole</h1>

<p align="center">
  A fast, self-hosted URL shortening service with click tracking.
</p>

<p align="center">
  <a href="#features">Features</a> · <a href="#quick-start">Quick Start</a> · <a href="#api-reference">API Reference</a> · <a href="#deployment">Deployment</a>
</p>

---

## Features

- **Shorten URLs** - Generate compact short links from any valid URL
- **Click tracking** - Monitor access counts per link
- **Full CRUD** - Create, read, update, and delete short links via REST
- **Minimal footprint** - Node.js, Express 5, PostgreSQL, no ORM overhead

## Tech Stack

| Layer      | Technology                  |
| ---------- | --------------------------- |
| Runtime    | Node.js 18+ / TypeScript 7  |
| Framework  | Express 5                   |
| Database   | PostgreSQL (via Docker)      |
| Driver     | pg (raw SQL, no ORM)        |

## Quick Start

### Prerequisites

- Node.js 18+
- Docker

### Setup

```bash
git clone https://github.com/FK78/wormhole.git
cd wormhole
npm install
cp .env.example .env
```

### Environment Variables

| Variable            | Description                        | Default      |
| ------------------- | ---------------------------------- | ------------ |
| `WORMHOLE_PORT`     | Port the API server listens on     | `3000`       |
| `POSTGRES_USER`     | PostgreSQL username                | `postgres`   |
| `POSTGRES_PASSWORD` | PostgreSQL password                | `postgres`   |
| `POSTGRES_DB`       | PostgreSQL database name           | `wormhole`   |
| `POSTGRES_PORT`     | PostgreSQL port                    | `5432`       |
| `HOST`              | Database host                      | `localhost`  |

### Run

```bash
# Start PostgreSQL
docker compose up -d

# Initialize the database schema
psql "$DATABASE_URL" -f db/schema.sql

# Start the development server
npm run dev
```

> **Tip:** Mount `db/schema.sql` into `/docker-entrypoint-initdb.d/` in `compose.yml` to auto-initialize the schema on first container boot. Note this only runs on a fresh volume - run `docker compose down -v` to reset if needed.

## API Reference

Base URL: `http://localhost:3000`

### Create a short URL

```
POST /shorten
```

**Request body:**

```json
{ "url": "https://www.example.com/some/long/url" }
```

**Response** `201 Created`:

```json
{
  "id": "1",
  "url": "https://www.example.com/some/long/url",
  "shortCode": "abc123",
  "createdAt": "2026-07-21T12:00:00Z",
  "updatedAt": "2026-07-21T12:00:00Z"
}
```

### Retrieve original URL

```
GET /shorten/:shortCode
```

**Response** `200 OK`:

```json
{
  "id": "1",
  "url": "https://www.example.com/some/long/url",
  "shortCode": "abc123",
  "createdAt": "2026-07-21T12:00:00Z",
  "updatedAt": "2026-07-21T12:00:00Z"
}
```

### Update a short URL

```
PUT /shorten/:shortCode
```

**Request body:**

```json
{ "url": "https://www.example.com/updated/url" }
```

**Response** `200 OK`

### Delete a short URL

```
DELETE /shorten/:shortCode
```

**Response** `204 No Content`

### Get link statistics

```
GET /shorten/:shortCode/stats
```

**Response** `200 OK`:

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

### Error Codes

| Code  | Description                          |
| ----- | ------------------------------------ |
| `400` | Invalid URL in request body          |
| `404` | Short code not found                 |
| `500` | Internal server error                |

## Project Structure

```
wormhole/
├── src/
│   ├── index.ts              # App entry point, DB health check
│   ├── routes/               # Route definitions
│   ├── controllers/          # Request handling
│   ├── services/             # Business logic
│   ├── queries/              # SQL queries
│   ├── middleware/           # Error handling, validation
│   ├── errors/               # Custom error classes
│   ├── utils/                # Helper functions
│   └── db/                   # Database connection pool
├── db/
│   └── schema.sql            # Table definitions
├── compose.yml               # Docker Compose for PostgreSQL
└── tsconfig.json
```

## Deployment

For production:

```bash
npm run start
```

Ensure `WORMHOLE_PORT`, database credentials, and `HOST` are set in the environment.

## Credit

Built as a solution to the [URL Shortening Service](https://roadmap.sh/projects/url-shortening-service) project on roadmap.sh.

## License

MIT
