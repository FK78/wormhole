import { pool } from "../db/db.ts";

export const insertShortLink = async (
  originalUrl: string,
  shortCode: string,
) => {
  const result = await pool.query(
    `INSERT INTO urls(url, short_code) VALUES ($1, $2) RETURNING *`,
    [originalUrl, shortCode],
  );
  return result.rows[0];
};

export const getUrl = async (shortCode: string) => {
  const result = await pool.query(`SELECT * FROM urls WHERE short_code = $1`, [shortCode])
  return result.rows[0]
}