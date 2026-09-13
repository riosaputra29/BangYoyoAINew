
// api/history.js
// Vercel Serverless Function -- otomatis jadi endpoint /api/history
// (satu file menangani GET dan POST, dibedakan lewat req.method,
//  supaya sama-sama bisa baca/tulis ke tabel chat_history yang sama)
//
// npm install @supabase/supabase-js google-auth-library
//
// Environment variables yang WAJIB diisi di Vercel
// (Project Settings -> Environment Variables):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   <- dari Supabase: Project Settings -> API -> service_role
//   GOOGLE_CLIENT_ID            <- sama dengan yang dipakai di public/index.html

const { createClient } = require("@supabase/supabase-js");
const { OAuth2Client } = require("google-auth-library");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

  // ---- GET /api/history: ambil riwayat chat milik user ini ----
  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("chat_history")
      .select("role, content, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(200); // batasi supaya payload tidak membengkak untuk user lama

    if (error) {
      console.error("Gagal mengambil riwayat chat:", error);
      return res.status(500).json({ error: "Gagal mengambil riwayat chat" });
    }

    return res.status(200).json({
      messages: data.map((row) => ({ role: row.role, content: row.content })),
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

    const { error } = await supabase.from("chat_history").insert({
      user_id: userId,
      role,
      content: safeContent,
    });

    if (error) {
      console.error("Gagal menyimpan riwayat chat:", error);
      return res.status(500).json({ error: "Gagal menyimpan riwayat chat" });
    }

    return res.status(201).json({ ok: true });
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ error: "Method tidak diizinkan" });
};
