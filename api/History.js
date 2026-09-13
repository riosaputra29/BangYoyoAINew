// api/history.js
// Vercel Serverless Function -- otomatis jadi endpoint /api/history
// Memakai NEON (Postgres), bukan Supabase -- query lewat HTTP driver resmi Neon
// yang memang didesain untuk serverless functions (tanpa pool koneksi TCP manual).
//
// npm install @neondatabase/serverless google-auth-library
//
// Environment variables yang WAJIB diisi di Vercel
// (Project Settings -> Environment Variables):
//   DATABASE_URL      <- connection string dari Neon console, contoh:
//                        postgresql://user:password@ep-xxxx.region.aws.neon.tech/dbname?sslmode=require
//   GOOGLE_CLIENT_ID  <- sama dengan yang dipakai di public/index.html

const { neon } = require("@neondatabase/serverless");
const { OAuth2Client } = require("google-auth-library");

const sql = neon(process.env.DATABASE_URL);
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Verifikasi Google ID token dari header Authorization: Bearer <token>.
// PENTING: user_id SELALU diambil dari token yang sudah diverifikasi di server ini,
// jangan pernah percaya user_id yang (mungkin) dikirim dari frontend.
async function getVerifiedUserId(req) {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return null;

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    return payload.sub; // ID akun Google yang stabil, dipakai sebagai user_id
  } catch (err) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  const userId = await getVerifiedUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Token tidak ada atau tidak valid" });
  }

  try {
    // ---- GET /api/history: ambil riwayat chat milik user ini ----
    if (req.method === "GET") {
      const rows = await sql`
        SELECT role, content, created_at
        FROM chat_history
        WHERE user_id = ${userId}
        ORDER BY created_at ASC
        LIMIT 200
      `;

      return res.status(200).json({
        messages: rows.map((row) => ({ role: row.role, content: row.content })),
      });
    }

    // ---- POST /api/history: simpan satu baris pesan ----
    if (req.method === "POST") {
      const { role, content } = req.body || {};

      if (role !== "user" && role !== "assistant") {
        return res.status(400).json({ error: "role harus 'user' atau 'assistant'" });
      }
      if (typeof content !== "string" || !content.trim()) {
        return res.status(400).json({ error: "content wajib diisi" });
      }

      const safeContent = content.slice(0, 20000); // jaga-jaga biar tidak ada baris raksasa

      await sql`
        INSERT INTO chat_history (user_id, role, content, created_at)
        VALUES (${userId}, ${role}, ${safeContent}, NOW())
      `;

      return res.status(201).json({ ok: true });
    }

    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method tidak diizinkan" });
  } catch (err) {
    // [DEBUG] log detail error asli ke Vercel Function Logs supaya gampang dilacak
    // kalau masih gagal (mis. salah nama kolom, DATABASE_URL belum keset, dll).
    console.error("Error /api/history:", err);
    return res.status(500).json({ error: "Gagal memproses riwayat chat" });
  }
};
