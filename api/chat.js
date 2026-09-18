import { OAuth2Client } from "google-auth-library";

import {
  getMemories,
  formatMemoriesForPrompt,
  saveChatMessage,
  createConversation,
  makeTitleFromMessage
} from "../lib/memory.js";

import { extractAndSaveFacts } from "../lib/extract.js";

import { verifyTanyaToken } from "../lib/auth.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const GROQ_API_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3,
  process.env.GROQ_KEY_4
].filter(Boolean);

// ROTASI KEY — round-robin murni:
// - nextKeyIndex maju otomatis setiap request SUKSES, jadi ke-4 key
//   kepakai merata seiring waktu (bukan selalu mulai dari key yang sama).
// - invalidKeyIndices menandai key yang pasti mati (401), supaya tidak
//   dicoba lagi di request-request berikutnya (hemat retry, tidak error).
let nextKeyIndex = 0;
const invalidKeyIndices = new Set();

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const VISION_MODEL = "qwen/qwen3.8-27b";

const MAX_IMAGES_PER_REQUEST = 5;

// TOKEN SAVING
const MAX_HISTORY_MESSAGES_FOR_MODEL = 4;
const MAX_DOCS_KEPT_FULL = 1;
const MAX_IMAGE_MSGS_KEPT_FULL = 1;
const MAX_MEMORY_CHARS_IN_PROMPT = 800;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/* =========================================================
   GOOGLE AUTH
========================================================= */

async function verifyGoogleToken(idToken) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID
  });

  const payload = ticket.getPayload();

  if (!payload) {
    throw new Error("Payload Google tidak ditemukan.");
  }

  return {
    userId: payload.sub,
    email: payload.email,
    name: payload.name || payload.email || "User",
    provider: "google"
  };
}

/* =========================================================
   MAGIC LINK TOKEN
========================================================= */

async function verifyMagicToken(token) {
  const data = await verifyTanyaToken(token);

  if (data.type !== "session") {
    throw new Error("Token session tidak valid.");
  }

  if (!data.userId) {
    throw new Error("User ID tidak ditemukan.");
  }

  return {
    userId: String(data.userId),
    email: data.email || null,
    name: data.name || data.email || "User",
    provider: data.auth_provider || "magic"
  };
}

/* =========================================================
   AUTH TOKEN
========================================================= */

async function verifyAuthToken(token) {
  if (!token) {
    throw new Error("Token login kosong.");
  }

  try {
    return await verifyGoogleToken(token);
  } catch (googleError) {
    console.log("Bukan Google token, mencoba Magic Link...");
  }

  return await verifyMagicToken(token);
}

/* =========================================================
   IMAGE
========================================================= */

function messageHasImage(message) {
  if (!message || !Array.isArray(message.content)) {
    return false;
  }

  return message.content.some(
    (part) => part && part.type === "image_url"
  );
}

/* =========================================================
   CAP IMAGE
========================================================= */

function capImagesPerRequest(messages, maxImages = MAX_IMAGES_PER_REQUEST) {
  let imageCount = 0;

  const reversed = [...messages].reverse();

  const capped = reversed.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    const newContent = message.content.filter((part) => {
      if (part && part.type === "image_url") {
        imageCount++;
        return imageCount <= maxImages;
      }
      return true;
    });

    return { ...message, content: newContent };
  });

  return capped.reverse();
}

/* =========================================================
   SLEEP
========================================================= */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* =========================================================
   GROQ
========================================================= */

// Pilih key berikutnya yang belum dicoba di request ini dan belum
// ditandai invalid. Mulai dari nextKeyIndex supaya rotasi merata
// antar-request, lalu putar sampai ketemu kandidat yang valid.
function pickKeyIndex(triedIndices) {
  const total = GROQ_API_KEYS.length;

  for (let step = 0; step < total; step++) {
    const idx = (nextKeyIndex + step) % total;

    if (!triedIndices.has(idx) && !invalidKeyIndices.has(idx)) {
      return idx;
    }
  }

  return null; // semua key sudah dicoba atau invalid
}

function callGroq(messages, modelId, maxTokens, triedIndices = new Set()) {
  if (GROQ_API_KEYS.length === 0) {
    return Promise.reject(
      new Error("GROQ API key belum dikonfigurasi.")
    );
  }

  const keyIndex = pickKeyIndex(triedIndices);

  if (keyIndex === null) {
    return Promise.reject(
      new Error("Semua Groq API key gagal, invalid, atau kena rate limit.")
    );
  }

  const apiKey = GROQ_API_KEYS[keyIndex];

  console.log(`Chat pakai Groq key ${keyIndex + 1}/${GROQ_API_KEYS.length}`);

  return fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature: 0.2
    })
  }).then(async (response) => {
    /*
     * 401 = API KEY INVALID -> tandai permanen, jangan dipakai lagi.
     * 429 = RATE LIMIT -> coba key lain, kecuali rate limit yang
     * disebabkan oleh request terlalu besar (bukan salah key).
     */

    if (response.status === 401) {
      console.log(`Groq key ${keyIndex + 1} invalid, ditandai skip.`);

      invalidKeyIndices.add(keyIndex);

      const nextTried = new Set(triedIndices).add(keyIndex);

      if (nextTried.size >= GROQ_API_KEYS.length) {
        return response;
      }

      await sleep(300 * nextTried.size);

      return callGroq(messages, modelId, maxTokens, nextTried);
    }

    if (response.status === 429) {
      const errorText = await response.clone().text().catch(() => "");

      // Request terlalu besar: jangan pindah API key, key ini baik-baik saja.
      if (
        errorText.includes("output tokens per minute") ||
        errorText.includes("Requested")
      ) {
        console.log("Groq: output token terlalu besar.");
        return response;
      }

      // Rate limit biasa -> coba key lain.
      console.log(`Groq key ${keyIndex + 1} terkena rate limit.`);

      const nextTried = new Set(triedIndices).add(keyIndex);

      if (nextTried.size >= GROQ_API_KEYS.length) {
        return response;
      }

      await sleep(300 * nextTried.size);

      return callGroq(messages, modelId, maxTokens, nextTried);
    }

    // Sukses -> majukan titik mulai rotasi untuk request berikutnya,
    // supaya keempat key kepakai merata dari waktu ke waktu.
    nextKeyIndex = (keyIndex + 1) % GROQ_API_KEYS.length;

    return response;
  });
}

/* =========================================================
   CLEAN MESSAGE
========================================================= */

function cleanMessages(messages) {
  return messages
    .filter((message) => {
      if (!message) return false;

      if (!["user", "assistant"].includes(message.role)) return false;

      if (typeof message.content === "string") {
        return message.content.trim() !== "";
      }

      if (Array.isArray(message.content)) {
        return message.content.length > 0;
      }

      return false;
    })
    .map((message) => {
      if (typeof message.content === "string") {
        return { role: message.role, content: message.content.trim() };
      }

      return { role: message.role, content: message.content };
    });
}

/* =========================================================
   DOCUMENT
========================================================= */

function containsDocument(content) {
  if (typeof content !== "string") return false;

  return (
    content.includes("[Isi file") ||
    content.includes('[File "') ||
    content.includes("--- Sheet:") ||
    content.includes("--- Halaman")
  );
}

/* =========================================================
   DOCUMENT NAME
========================================================= */

function getDocumentName(content) {
  if (typeof content !== "string") return "dokumen";

  const match =
    content.match(/\[Isi file "([^"]+)"\]/i) ||
    content.match(/\[File "([^"]+)"\]/i);

  return match?.[1] || "dokumen";
}

/* =========================================================
   DOCUMENT INSTRUCTION
========================================================= */

function buildDocumentInstruction(content) {
  if (!containsDocument(content)) return null;

  const fileName = getDocumentName(content);

  return `

DOKUMEN USER

Nama file: ${fileName}

Gunakan dokumen sebagai sumber utama.
Jangan mengarang data.

`;
}

/* =========================================================
   TRIM MESSAGE
========================================================= */

function trimMessagesForModel(messages) {
  const imageIndices = [];

  messages.forEach((message, index) => {
    if (messageHasImage(message)) imageIndices.push(index);
  });

  const imageIndicesToStrip = new Set(
    imageIndices.slice(
      0,
      Math.max(0, imageIndices.length - MAX_IMAGE_MSGS_KEPT_FULL)
    )
  );

  const docIndices = [];

  messages.forEach((message, index) => {
    if (
      typeof message.content === "string" &&
      containsDocument(message.content)
    ) {
      docIndices.push(index);
    }
  });

  const docIndicesToStrip = new Set(
    docIndices.slice(
      0,
      Math.max(0, docIndices.length - MAX_DOCS_KEPT_FULL)
    )
  );

  let trimmed = messages.map((message, index) => {
    if (imageIndicesToStrip.has(index)) {
      const textPart = Array.isArray(message.content)
        ? message.content.find((part) => part && part.type === "text")
        : null;

      const label = textPart?.text?.trim() || "(Gambar terlampir)";

      return {
        role: message.role,
        content: label + "\n[Gambar lama tidak dikirim ulang]"
      };
    }

    if (docIndicesToStrip.has(index)) {
      const fileName = getDocumentName(message.content);

      return {
        role: message.role,
        content: `[Dokumen "${fileName}" sudah dianalisis. Isi tidak dikirim ulang]`
      };
    }

    return message;
  });

  if (trimmed.length > MAX_HISTORY_MESSAGES_FOR_MODEL) {
    trimmed = trimmed.slice(
      trimmed.length - MAX_HISTORY_MESSAGES_FOR_MODEL
    );
  }

  return trimmed;
}

/* =========================================================
   BUILD GROQ MESSAGE
========================================================= */

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return String(content ?? "");
}

// System prompt dipangkas ±65% dari versi asli. Semua aturan inti
// (fokus LiDAR/GIS, bebas bantu coding umum, format output, aturan
// finansial, aturan memory) tetap ada, tapi ditulis lebih padat
// supaya token per-request jauh lebih kecil, termasuk untuk pesan
// pendek seperti "halo".
const SYSTEM_PROMPT_TEMPLATE = (memoryText) => `Kamu Tanya, asisten AI spesialis LiDAR/GIS/terrain/hidrologi/data spasial, sekaligus asisten coding umum (semua bahasa pemrograman).

Bahasa Indonesia default, ikuti bahasa user. Jawab ringkas, teknis, berbasis data. Jangan mengarang. Pisahkan FAKTA / ASUMSI / ESTIMASI. Kalau data kurang, sebutkan data yang dibutuhkan.

DI LUAR LiDAR/GIS: kalau diminta script/kode/function bahasa apa pun yang tidak terkait LiDAR/GIS, langsung buatkan selengkap mungkin seperti asisten coding biasa (penjelasan singkat + code block). Jangan menolak, jangan bilang di luar keahlian, jangan alihkan ke topik LiDAR/GIS. Format khusus LiDAR/GIS di bawah HANYA untuk analisis spasial.

ANALISIS LiDAR/GIS — perhatikan: elevasi, slope, aspect, terrain, drainage, flow path/accumulation, depression, watershed. Bedakan DSM/DTM/DEM/point cloud (LAS/LAZ) bila info tersedia. Untuk banjir: identifikasi area rendah, arah aliran, titik akumulasi, hambatan, kanal, tanggul — pakai istilah "indikasi/potensi/perlu validasi", jangan klaim pasti tanpa simulasi hidrologi/hidraulika. Kalau ada data before/after, analisis perubahan elevasi & indikasi cut/fill. Pakai angka eksplisit dari data yang ada; jangan mengarang koordinat/luas/elevasi/volume/lokasi.

Urutan analisis: DATA -> ELEVASI -> TERRAIN -> DRAINAGE -> RISIKO -> DAMPAK -> TINDAKAN -> VALIDASI.

Format output (khusus analisis LiDAR/GIS/banjir/kanal/tanggul, jika relevan):
TEMUAN / DAMPAK FINANSIAL (Rp)/WAKTU / TINDAKAN / REKOMENDASI TEKNIS / PRIORITAS / AREA / VALIDASI

PERHITUNGAN: dilarang LaTeX/HTML. Pakai teks biasa dengan +, -, ×, ÷. Contoh:
Total = Rp 136.250.000
Biaya = Rp 125.000.000
Penghematan = Rp 136.250.000 - Rp 125.000.000 = Rp 11.250.000

ESTIMASI FINANSIAL: hitung Rupiah hanya jika data cukup. Rumus dasar: Kerugian = Area × Nilai/ha × %kehilangan. Untuk banjir/infrastruktur, tambahkan jika tersedia: kehilangan produksi + kerusakan aset + recovery + downtime. Jangan mengarang harga/luas/persentase/volume/biaya. Semua asumsi wajib ditandai "Asumsi: ...". Pakai Rp juta/miliar untuk angka besar. Estimasi bukan angka pasti, perlu validasi.

ATURAN DATA LiDAR: jangan ubah satuan tanpa menyebut konversinya; jangan simpulkan kedalaman genangan hanya dari elevasi tanpa muka air; jangan simpulkan debit/kapasitas kanal tanpa data hidrologi/hidraulika; jangan sebut hasil sebagai simulasi kalau hanya interpretasi DEM/DTM; pertimbangkan resolusi raster/point density serta konsistensi CRS/datum/satuan bila tersedia; sebutkan bagian yang perlu ground truth/check survey.

MEMORY: jika ada "nama: X", panggil user "X" tiap jawaban. Jangan tanya nama kalau sudah tersedia.

${memoryText}`;

function buildGroqMessages(cleanMessages, memoryText, useVision) {
  const result = [];

  result.push({
    role: "system",
    content: SYSTEM_PROMPT_TEMPLATE(memoryText)
  });

  for (const message of cleanMessages) {
    if (typeof message.content === "string") {
      const documentInstruction =
        message.role === "user"
          ? buildDocumentInstruction(message.content)
          : null;

      if (documentInstruction) {
        result.push({ role: "system", content: documentInstruction });
      }

      result.push({ role: message.role, content: message.content });
    } else {
      // Content array hanya boleh dipakai untuk pesan terakhir yang
      // sedang mengirim gambar ke Vision model.
      if (
        useVision &&
        message === cleanMessages[cleanMessages.length - 1] &&
        Array.isArray(message.content)
      ) {
        result.push({ role: message.role, content: message.content });
      } else {
        // Gambar dari chat sebelumnya diubah jadi text agar tidak
        // error di model text.
        result.push({
          role: message.role,
          content: normalizeMessageContent(message.content)
        });
      }
    }
  }

  return result;
}

/* =========================================================
   MAIN HANDLER
========================================================= */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  /* =======================================================
     AUTH HEADER
  ======================================================= */

  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Belum login" });
  }

  const idToken = authHeader.substring(7).trim();

  /* =======================================================
     VERIFY GOOGLE / MAGIC LINK
  ======================================================= */

  let user;

  try {
    user = await verifyAuthToken(idToken);
  } catch (err) {
    console.error("Auth error:", err);

    return res
      .status(401)
      .json({ error: "Sesi login tidak valid atau sudah expired" });
  }

  const userId = user.userId;

  console.log(
    `User login: ${user.email || userId} | provider=${user.provider}`
  );

  /* =======================================================
     REQUEST BODY
  ======================================================= */

  const { messages, conversationId, projectId } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Pesan kosong" });
  }

  const clean = cleanMessages(messages);

  const lastUserMessage = [...clean]
    .reverse()
    .find((message) => message.role === "user");

  /* =======================================================
     CONVERSATION
  ======================================================= */

  let convId = conversationId ? Number(conversationId) : null;

  if (!convId) {
    const title = lastUserMessage
      ? makeTitleFromMessage(
          typeof lastUserMessage.content === "string"
            ? lastUserMessage.content
            : "Analisis gambar"
        )
      : "Percakapan baru";

    const conv = await createConversation(userId, title, projectId || null);

    convId = conv.id;
  }

  /* =======================================================
     MEMORY
  ======================================================= */

  let memoryText = "Belum ada memory tersimpan.";

  try {
    const memories = await getMemories(userId);

    memoryText = formatMemoriesForPrompt(memories);

    console.log(`Memory ditemukan: ${memories.length} item`);
  } catch (err) {
    console.error("Gagal ambil memories:", err);
  }

  if (memoryText.length > MAX_MEMORY_CHARS_IN_PROMPT) {
    memoryText = memoryText.slice(0, MAX_MEMORY_CHARS_IN_PROMPT);

    const lastNewLine = memoryText.lastIndexOf("\n");

    if (lastNewLine > 0) {
      memoryText = memoryText.substring(0, lastNewLine);
    }

    memoryText += "\n[Memory lama dipotong]";
  }

  console.log("Memory dikirim ke AI:", memoryText);

  /* =======================================================
     VISION
  ======================================================= */

  const useVision =
    !!lastUserMessage && messageHasImage(lastUserMessage);

  const trimmedForModel = trimMessagesForModel(clean);

  let groqMessages = buildGroqMessages(trimmedForModel, memoryText, useVision);

  if (useVision) {
    groqMessages = capImagesPerRequest(groqMessages);
  }

  const modelToUse = useVision ? VISION_MODEL : MODEL;

  const maxOutputTokens = useVision ? 1000 : 800;

  /* =======================================================
     SAVE USER MESSAGE
  ======================================================= */

  if (lastUserMessage) {
    const savedContent =
      typeof lastUserMessage.content === "string"
        ? lastUserMessage.content
        : "[Lampiran gambar]";

    saveChatMessage(userId, convId, "user", savedContent).catch(
      console.error
    );
  }

  /* =======================================================
     GROQ
  ======================================================= */

  let upstream;

  try {
    upstream = await callGroq(groqMessages, modelToUse, maxOutputTokens);
  } catch (err) {
    console.error("Groq error:", err);

    return res.status(502).json({ error: "Tidak dapat menghubungi AI" });
  }

  if (!upstream.ok || !upstream.body) {
    const errorText = await upstream.text().catch(() => "");

    console.error("GROQ ERROR:", {
      status: upstream.status,
      body: errorText
    });

    // Pertahankan 429 sebagai rate limit.
    if (upstream.status === 429) {
      return res
        .status(429)
        .json({ error: "Limit Groq sudah tercapai. Silakan coba lagi nanti." });
    }

    // Semua error dari Groq jangan diteruskan sebagai 401 agar
    // frontend tidak menganggap sesi login habis.
    return res.status(502).json({
      error: errorText || "Gagal mendapatkan respons dari AI.",
      code: "GROQ_ERROR"
    });
  }

  /* =======================================================
     SSE
  ======================================================= */

  res.status(200);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Conversation-Id", String(convId));

  if (res.flushHeaders) {
    res.flushHeaders();
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  let sseBuffer = "";
  let fullReply = "";

  /* =======================================================
     PROCESS SSE
  ======================================================= */

  function processSSEChunk(chunkText) {
    sseBuffer += chunkText;

    const lines = sseBuffer.split("\n");

    sseBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();

      if (payload === "[DONE]") continue;

      try {
        const json = JSON.parse(payload);

        const delta = json?.choices?.[0]?.delta?.content;

        if (typeof delta === "string") {
          fullReply += delta;
        }
      } catch {
        // Abaikan SSE yang tidak valid.
      }
    }
  }

  /* =======================================================
     STREAM RESPONSE
  ======================================================= */

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      res.write(value);

      processSSEChunk(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    console.error("Streaming error:", err);
  }

  /* =======================================================
     SAVE ASSISTANT
  ======================================================= */

  if (fullReply.trim()) {
    await saveChatMessage(userId, convId, "assistant", fullReply.trim());
  }

  /* =======================================================
     EXTRACT MEMORY
  ======================================================= */

  if (lastUserMessage && typeof lastUserMessage.content === "string") {
    console.log("Mulai ekstrak memory...");

    await extractAndSaveFacts(userId, lastUserMessage.content);
  }

  /* =======================================================
     END
  ======================================================= */

  res.end();
}
