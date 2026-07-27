import { pool } from "../db/db.ts";

type urlRow = {
    id: string,
    url: string,
    short_code: string,
    access_count?: number,
    created_at: Date,
    updated_at: Date
}

type urlRecord = {
    id: string,
    url: string,
    shortCode: string,
    accessCount?: number,
    createdAt: Date,
    updatedAt: Date
}

const mapRow = (row: urlRow): urlRecord => ({
    id: row.id,
    url: row.url,
    shortCode: row.short_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.access_count !== undefined && { accessCount: row.access_count })

})

export const insertShortLink = async (
  originalUrl: string,
  shortCode: string,
) => {
  const result = await pool.query(
    `INSERT INTO urls(url, short_code) VALUES ($1, $2) RETURNING id, url, short_code, created_at, updated_at`,
    [originalUrl, shortCode],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
};

export const getUrl = async (shortCode: string) => {
  const result = await pool.query(`SELECT id, url, short_code, created_at, updated_at FROM urls WHERE short_code = $1`, [shortCode])
  return result.rows[0] ? mapRow(result.rows[0]) : null

}

export const shortCodeExists = async (shortCode: string) => {
  const result = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM urls WHERE short_code = $1) AS exists`,
    [shortCode],
  );
  return result.rows[0].exists
};

export const updateOriginalUrl = async (url: string, shortCode: string) => {
  const result = await pool.query(`UPDATE urls SET url = $1 WHERE short_code = $2 RETURNING id, url, short_code, created_at, updated_at`, [url, shortCode])
  return result.rows[0]
}