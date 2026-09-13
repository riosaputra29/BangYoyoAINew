import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL belum diset di Environment Variables Vercel");
}

// Koneksi via HTTP — aman dipakai di serverless function Vercel,
// tidak butuh connection pool seperti `pg.Pool`.
export const sql = neon(process.env.DATABASE_URL);
