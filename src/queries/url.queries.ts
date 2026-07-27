import { pool } from "../db/db.ts";

export const insertShortLink = async (
  originalUrl: string,
  shortCode: string,
) => {
  const result = await pool.query(
    `INSERT INTO urls(url, short_code) VALUES ($1, $2) RETURNING id, url, short_code, created_at, updated_at`,
    [originalUrl, shortCode],
  );
  return result.rows[0];
};

export const getUrl = async (shortCode: string) => {
  const result = await pool.query(`SELECT id, url, short_code, created_at, updated_at FROM urls WHERE short_code = $1`, [shortCode])
  return result.rows[0]
}