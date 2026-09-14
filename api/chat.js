import { OAuth2Client } from "google-auth-library";
import { getMemories, formatMemoriesForPrompt, saveChatMessage, createConversation, makeTitleFromMessage } from "../lib/memory.js";
import { extractAndSaveFacts } from "../lib/extract.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// 1. UBAH JADI ARRAY 2 KEY
const GROQ_API_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2
];
let currentKeyIndex = 0; // buat nandain key yg lagi dipake

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

// 2. FUNGSI BARU BUAT PANGGIL GROQ + ROTASI
async function callGroq(messages) {
  const apiKey = GROQ_API_KEYS[currentKeyIndex];

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey, // pake key yg aktif
    },
    body: JSON.stringify({
      model: MODEL,
      messages: messages,
      stream: true,
      max_tokens: 2000,
    }),
  });

  // KALAU KENA LIMIT 429, GANTI KEY & COBA LAGI
  if (response.status === 429) {
    console.log(`Key ${currentKeyIndex + 1} kena limit. Pindah ke key ${currentKeyIndex + 2}`);
    currentKeyIndex = (currentKeyIndex + 1) % GROQ_API_KEYS.length;
    return callGroq(messages); // retry
  }

  return response;
}

export default async function handler(req, res) {
  if (req.method!== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Belum login dengan Google." });
    return;
  }
  const idToken = authHeader.substring(7).trim();

  let userId;
  try {
    const googleUser = await verifyGoogleToken(idToken);
    console.log(`Google login: ${googleUser.email || "unknown"}`);
    userId = googleUser.sub;
  } catch (err) {
    console.error("Google verification error:", err.message);
    res.status(401).json({ error: "Sesi Google tidak valid atau sudah kedaluwarsa." });
    return;
  }

  const { messages, conversationId } = req.body || {};
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
        m.content.trim()!== ""
    )
   .map((m) => ({ role: m.role, content: m.content.trim() }));

  if (cleanMessages.length === 0) {
    res.status(400).json({ error: "Tidak ada pesan yang valid." });
    return;
  }

  const lastUserMessage = [...cleanMessages].reverse().find((m) => m.role === "user");

  let convId = conversationId? Number(conversationId) : null;
  if (!convId) {
    try {
      const title = makeTitleFromMessage(lastUserMessage?.content);
      const conv = await createConversation(userId, title);
      convId = conv.id;
    } catch (err) {
      console.error("Gagal membuat percakapan baru:", err);
      res.status(500).json({ error: "Gagal membuat percakapan baru." });
      return;
    }
  }

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

  if (lastUserMessage) {
    saveChatMessage(userId, convId, "user", lastUserMessage.content).catch((err) =>
      console.error("Gagal simpan pesan user:", err)
    );
  }

  // 3. PANGGIL FUNGSI BARU DI SINI
  let upstream;
  try {
    upstream = await callGroq(groqMessages); // <--- UDAH DIGANTI
  } catch (err) {
    console.error("Groq connection error:", err);
    res.status(502).json({ error: "Tidak dapat menghubungi layanan AI." });
    return;
  }

  if (!upstream.ok ||!upstream.body) {
    const errorText = await upstream.text().catch(() => "");
    console.error("Groq API Error:", upstream.status, errorText);
    let message = "Gagal mendapatkan respons dari AI.";
    try {
      message = JSON.parse(errorText)?.error?.message || message;
    } catch {}
    res.status(upstream.status).json({ error: message });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Conversation-Id", String(convId));
  if (res.flushHeaders) res.flushHeaders();

  const reader = upstream.body.getReader();
  req.on("close", () => reader.cancel().catch(() => {}));

  const decoder = new TextDecoder();
  let sseBuffer = "";
  let fullReply = "";

  function processSSEChunk(chunkText) {
    sseBuffer += chunkText;
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop()?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") fullReply += delta;
      } catch {}
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      processSSEChunk(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    console.error("Streaming error:", err);
  } finally {
    res.end();

    if (fullReply.trim()) {
      try {
        await saveChatMessage(userId, convId, "assistant", fullReply.trim());
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
