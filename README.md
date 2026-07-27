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
- **PostgreSQL** — running in Docker
- **pg** — raw SQL, no ORM
- No auth — this one's open season

## Endpoints

| Method   | Route                  | What it does                       |
| -------- | ---------------------- | ---------------------------------- |
| `POST`   | `/shorten`             | Compress a URL into oblivion       |
| `GET`    | `/shorten/:code`       | Retrieve the original URL          |
| `PUT`    | `/shorten/:code`       | Point the shortcode somewhere else |
| `DELETE` | `/shorten/:code`       | Erase it from existence            |
| `GET`    | `/shorten/:code/stats` | See how popular your link is       |

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

`.env.example` looks like this — adjust values to match your setup:

```bash
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wormhole
```

| Variable       | Description                             |
| -------------- | --------------------------------------- |
| `PORT`         | Port the Express server listens on      |
| `DATABASE_URL` | Postgres connection string used by `pg` |

Start the database:

```bash
docker compose up -d
```

Create the tables:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

> **Tip:** you can skip this manual step by mounting `db/schema.sql` into `/docker-entrypoint-initdb.d/` in `compose.yml` — Postgres runs any `.sql` files there automatically on first boot. Just note it only fires on a fresh volume, so if you've already started the container once, run `docker compose down -v` first to reset it.

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
│   │   └── shortenRouter.ts
│   ├── controllers/
│   │   └── shortenController.ts
│   ├── queries/
│   │   └── shortenQueries.ts
│   ├── middleware/
│   │   └── validate.ts
│   ├── utils/
│   │   └── generateCode.ts
│   └── db/
│       └── db.ts
├── db/
│   └── schema.sql
├── .env.example
├── compose.yml
└── tsconfig.json
```

## Requirements

- Node.js 18+
- Docker (for PostgreSQL)
- Long URLs that need shortening (shouldn't be hard to find)

## Credit

Built as a solution to the [URL Shortening Service](https://roadmap.sh/projects/url-shortening-service) project on roadmap.sh.

## License

MIT — shorten it, fork it, wormhole it.
