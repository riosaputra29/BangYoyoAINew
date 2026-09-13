import { OAuth2Client } from "google-auth-library";
import { getConversations, createConversation } from "../lib/memory.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

async function verifyAndGetUserId(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) throw new Error("Belum login.");
  const ticket = await googleClient.verifyIdToken({
    idToken: authHeader.substring(7).trim(),
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload) throw new Error("Payload Google tidak ditemukan.");
  return payload.sub;
}

// GET  /api/conversations       -> daftar semua percakapan user (buat sidebar)
// POST /api/conversations       -> buat percakapan baru
export default async function handler(req, res) {
  let userId;
  try {
    userId = await verifyAndGetUserId(req);
  } catch (err) {
    res.status(401).json({ error: "Sesi Google tidak valid atau sudah kedaluwarsa." });
    return;
  }

  if (req.method === "GET") {
    try {
      const conversations = await getConversations(userId);
      res.status(200).json({ conversations });
    } catch (err) {
      console.error("Get conversations error:", err);
      res.status(500).json({ error: "Gagal mengambil daftar percakapan." });
    }
    return;
  }

  if (req.method === "POST") {
    try {
      const { title } = req.body || {};
      const conversation = await createConversation(userId, title || "Percakapan baru");
      res.status(200).json({ conversation });
    } catch (err) {
      console.error("Create conversation error:", err);
      res.status(500).json({ error: "Gagal membuat percakapan baru." });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
