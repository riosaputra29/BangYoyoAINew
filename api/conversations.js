import { OAuth2Client } from "google-auth-library";

import {
  getConversations,
  createConversation,
  deleteConversation
} from "../lib/memory.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

async function verifyAndGetUserId(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    throw new Error("Belum login.");
  }

  const ticket = await googleClient.verifyIdToken({
    idToken: authHeader.substring(7).trim(),
    audience: GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  if (!payload) {
    throw new Error("Payload Google tidak ditemukan.");
  }

  return payload.sub;
}


// GET     /api/conversations
// POST    /api/conversations
// DELETE  /api/conversations?conversationId=123

export default async function handler(req, res) {

  let userId;

  // ==========================================
  // VERIFIKASI USER GOOGLE
  // ==========================================
  try {
    userId = await verifyAndGetUserId(req);

  } catch (err) {

    res.status(401).json({
      error: "Sesi Google tidak valid atau sudah kedaluwarsa."
    });

    return;
  }


  // ==========================================
  // GET
  // Ambil semua percakapan user
  // ==========================================
  if (req.method === "GET") {
  
    try {
  
      const { projectId } = req.query;
  
      const conversations = await getConversations(
        userId,
        projectId ? Number(projectId) : null
      );
  
      res.status(200).json({
        conversations
      });
  
    } catch (err) {
  
      console.error("Get conversations error:", err);
  
      res.status(500).json({
        error: "Gagal mengambil daftar percakapan."
      });
    }
  
    return;
  }
  


  // ==========================================
  // POST
  // Buat percakapan baru
  // ==========================================
  if (req.method === "POST") {
  
    try {
  
      const { title, projectId } = req.body || {};
  
      const conversation = await createConversation(
        userId,
        title || "Percakapan baru",
        projectId || null
      );
  
      res.status(200).json({
        conversation
      });
  
    } catch (err) {
  
      console.error("Create conversation error:", err);
  
      res.status(500).json({
        error: "Gagal membuat percakapan baru."
      });
    }
  
    return;
  }


  // ==========================================
  // DELETE
  // Hapus satu percakapan milik user
  // ==========================================
  if (req.method === "DELETE") {

    try {

      const conversationId =
        req.query?.conversationId ||
        req.body?.conversationId;

      if (!conversationId) {

        res.status(400).json({
          error: "conversationId wajib diisi."
        });

        return;
      }


      const deleted = await deleteConversation(
        userId,
        Number(conversationId)
      );


      if (!deleted) {

        res.status(404).json({
          error: "Percakapan tidak ditemukan atau bukan milik user."
        });

        return;
      }


      res.status(200).json({
        success: true,
        message: "Percakapan berhasil dihapus."
      });

    } catch (err) {

      console.error("Delete conversation error:", err);

      res.status(500).json({
        error: "Gagal menghapus percakapan."
      });
    }

    return;
  }


  // ==========================================
  // METHOD TIDAK DIIZINKAN
  // ==========================================
  res.status(405).json({
    error: "Method not allowed"
  });
}
