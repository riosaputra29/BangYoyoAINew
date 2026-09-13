import { OAuth2Client } from "google-auth-library";
import { getMemories, getChatHistory } from "../lib/memory.js"; // [MEMORY]

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// GET /api/memories  (Authorization: Bearer <google id token>)
// Sengaja tidak menerima userId dari luar — selalu pakai identitas
// dari token Google yang sedang login, biar user cuma bisa lihat
// memory & chat history miliknya sendiri.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Belum login dengan Google." });
    return;
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: authHeader.substring(7).trim(),
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload) throw new Error("Payload Google tidak ditemukan.");

    // [MEMORY] Ambil keduanya sekaligus — dipanggil sekali saat layar
    // chat dibuka, jadi tidak perlu dua request terpisah dari frontend.
    const [memories, chatHistory] = await Promise.all([
      getMemories(payload.sub),
      getChatHistory(payload.sub),
    ]);

    res.status(200).json({ memories, chatHistory });
  } catch (err) {
    console.error("Get memories error:", err.message);
    res.status(401).json({ error: "Sesi Google tidak valid atau sudah kedaluwarsa." });
  }
}
