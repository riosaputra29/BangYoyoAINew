import { OAuth2Client } from "google-auth-library";
import { getMemories, formatMemoriesForPrompt } from "../lib/memory.js";
import { saveMessage } from "../lib/messages.js"; // [MEMORY]
import { extractAndSaveFacts } from "../lib/extract.js"; // [MEMORY]

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

async function verifyGoogleToken(idToken) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload) throw new Error("Payload Google tidak ditemukan.");
  return payload;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // 1. Cek header Authorization
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Belum login dengan Google." });
    return;
  }
  const idToken = authHeader.substring(7).trim();

  // 2. Verifikasi token Google
  let userId; // [MEMORY] dipakai sebagai key di tabel memories & messages
  try {
    const googleUser = await verifyGoogleToken(idToken);
    console.log(`Google login: ${googleUser.email || "unknown"}`);
    userId = googleUser.sub; // [MEMORY] "sub" = ID Google yang stabil, lebih aman dari email
  } catch (err) {
    console.error("Google verification error:", err.message);
    res.status(401).json({ error: "Sesi Google tidak valid atau sudah kedaluwarsa." });
    return;
  }

  // 3. Validasi & bersihkan messages
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "Pesan kosong atau format salah." });
    return;
  }
  const cleanMessages = messages
    .filter(
      (m) =>
        m &&
        ["user", "assistant"].includes(m.role) &&
        typeof m.content === "string" &&
        m.content.trim() !== ""
    )
    .map((m) => ({ role: m.role, content: m.content.trim() }));

  if (cleanMessages.length === 0) {
    res.status(400).json({ error: "Tidak ada pesan yang valid." });
    return;
  }

  // [MEMORY] Pesan baru dari user = item terakhir yang role-nya "user"
  const lastUserMessage = [...cleanMessages].reverse().find((m) => m.role === "user");

  // [MEMORY] Ambil memory (fakta jangka panjang) tersimpan buat user ini.
  // Kalau gagal (misal DB lagi bermasalah), jangan sampai bikin chat gagal total —
  // cukup jalan tanpa konteks memory.
  let memoryText = "Belum ada memory tersimpan untuk user ini.";
  try {
    const memories = await getMemories(userId);
    memoryText = formatMemoriesForPrompt(memories);
  } catch (err) {
    console.error("Gagal ambil memories:", err);
  }

  const groqMessages = [
    {
      role: "system",
      content:
        "Kamu adalah Tanya, asisten AI yang ramah, profesional, membantu, dan menjawab dalam bahasa Indonesia kecuali pengguna meminta bahasa lain.\n\n" +
        `Berikut yang kamu tahu tentang user ini:\n${memoryText}\n\n` +
        'Gunakan info ini secara natural kalau relevan. Jangan sebut-sebut kalau kamu "mengambil dari database" atau semacamnya.',
    },
    ...cleanMessages,
  ];

  // [MEMORY] Simpan pesan user ke DB. Tidak di-await blocking penuh alur utama
  // kalau gagal — cukup di-log, chat tetap lanjut.
  if (lastUserMessage) {
    saveMessage(userId, "user", lastUserMessage.content).catch((err) =>
      console.error("Gagal simpan pesan user:", err)
    );
  }

  // 4. Panggil Groq (streaming)
  let upstream;
  try {
    upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: groqMessages,
        stream: true,
        max_tokens: 2000,
      }),
    });
  } catch (err) {
    console.error("Groq connection error:", err);
    res.status(502).json({ error: "Tidak dapat menghubungi layanan AI." });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const errorText = await upstream.text().catch(() => "");
    console.error("Groq API Error:", upstream.status, errorText);
    let message = "Gagal mendapatkan respons dari AI.";
    try {
      message = JSON.parse(errorText)?.error?.message || message;
    } catch {}
    res.status(upstream.status).json({ error: message });
    return;
  }

  // 5. Stream balik ke browser
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (res.flushHeaders) res.flushHeaders();

  const reader = upstream.body.getReader();
  req.on("close", () => reader.cancel().catch(() => {}));

  // [MEMORY] Selain diteruskan mentah ke browser, kita juga parse tiap chunk
  // SSE-nya buat mengumpulkan teks balasan lengkap, supaya bisa disimpan ke
  // DB setelah stream selesai (client tidak melihat proses ini sama sekali).
  const decoder = new TextDecoder(); // [MEMORY]
  let sseBuffer = ""; // [MEMORY]
  let fullReply = ""; // [MEMORY]

  function processSSEChunk(chunkText) {
    // [MEMORY]
    sseBuffer += chunkText;
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop() ?? ""; // sisa baris belum lengkap, simpan buat chunk berikutnya
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") fullReply += delta;
      } catch {
        // baris tidak lengkap/bukan JSON valid, abaikan saja
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value); // teruskan mentah ke browser, tidak diubah sama sekali
      processSSEChunk(decoder.decode(value, { stream: true })); // [MEMORY]
    }
  } catch (err) {
    console.error("Streaming error:", err);
  } finally {
    res.end();

    // [MEMORY] Setelah stream selesai & response sudah ditutup ke user,
    // simpan balasan lengkap + jalankan ekstraksi fakta baru ke memory.
    // Vercel tetap menjaga function ini hidup sampai handler selesai,
    // jadi await di sini aman walau res sudah di-end().
    if (fullReply.trim()) {
      try {
        await saveMessage(userId, "assistant", fullReply.trim());
      } catch (err) {
        console.error("Gagal simpan balasan assistant:", err);
      }
    }
    if (lastUserMessage) {
      try {
        await extractAndSaveFacts(userId, lastUserMessage.content);
      } catch (err) {
        console.error("Gagal ekstrak/simpan memory:", err);
      }
    }
  }
}
