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

// =========================================================
// ROTASI KEY
// =========================================================

let nextKeyIndex = 0;

const invalidKeyIndices = new Set();

const MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const VISION_MODEL = "qwen/qwen3.8-27b";

const MAX_IMAGES_PER_REQUEST = 5;

// TOKEN SAVING
const MAX_HISTORY_MESSAGES_FOR_MODEL = 4;
const MAX_IMAGE_MSGS_KEPT_FULL = 1;
const MAX_MEMORY_CHARS_IN_PROMPT = 800;
// Catatan: MAX_DOCS_KEPT_FULL sudah tidak dipakai lagi.
// Dokumen sekarang cuma utuh di pesan TERAKHIR (lihat
// trimMessagesForModel) — tidak ada lagi toleransi
// "bertahan beberapa giliran".

const googleClient =
  new OAuth2Client(GOOGLE_CLIENT_ID);

// =========================================================
// GOOGLE AUTH
// =========================================================

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

// =========================================================
// MAGIC LINK TOKEN
// =========================================================

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

// =========================================================
// AUTH TOKEN
// =========================================================

async function verifyAuthToken(token) {
  if (!token) {
    throw new Error("Token login kosong.");
  }

  try {
    return await verifyGoogleToken(token);
  } catch (googleError) {
    console.log(
      "Bukan Google token, mencoba Magic Link..."
    );
  }

  return await verifyMagicToken(token);
}

// =========================================================
// IMAGE
// =========================================================

function messageHasImage(message) {
  if (!message || !Array.isArray(message.content)) {
    return false;
  }

  return message.content.some(
    (part) => part && part.type === "image_url"
  );
}

// =========================================================
// CAP IMAGE
// =========================================================

function capImagesPerRequest(
  messages,
  maxImages = MAX_IMAGES_PER_REQUEST
) {
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

    return {
      ...message,
      content: newContent
    };
  });

  return capped.reverse();
}

// =========================================================
// PARSE RETRY-AFTER
// =========================================================

function parseRetryAfterSeconds(
  response,
  errorText = ""
) {
  // 1. Header Retry-After
  const retryAfterHeader =
    response?.headers?.get("retry-after");

  if (retryAfterHeader) {
    const value = retryAfterHeader.trim();

    // Contoh:
    // Retry-After: 5
    const seconds = Number(value);

    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds);
    }

    // Retry-After bisa berupa HTTP date
    const retryDate = Date.parse(value);

    if (!Number.isNaN(retryDate)) {
      const diff =
        (retryDate - Date.now()) / 1000;

      return Math.max(0, Math.ceil(diff));
    }
  }

  // 2. Coba ambil dari body/error Groq
  if (typeof errorText === "string") {
    const patterns = [
      /try again in\s+([\d.]+)\s*s/i,
      /retry after\s+([\d.]+)\s*s/i,
      /retry-after["']?\s*[:=]\s*([\d.]+)/i,
      /in\s+([\d.]+)\s*seconds?/i
    ];

    for (const pattern of patterns) {
      const match = errorText.match(pattern);

      if (match) {
        const seconds = Number(match[1]);

        if (
          Number.isFinite(seconds) &&
          seconds >= 0
        ) {
          return Math.ceil(seconds);
        }
      }
    }
  }

  return null;
}

// =========================================================
// GROQ
// =========================================================

// Pilih key berikutnya yang:
// - belum dicoba pada request ini
// - tidak ditandai invalid
function pickKeyIndex(triedIndices) {
  const total = GROQ_API_KEYS.length;

  for (let step = 0; step < total; step++) {
    const idx =
      (nextKeyIndex + step) % total;

    if (
      !triedIndices.has(idx) &&
      !invalidKeyIndices.has(idx)
    ) {
      return idx;
    }
  }

  return null;
}

// =========================================================
// CALL GROQ
// =========================================================

async function callGroq(
  messages,
  modelId,
  maxTokens,
  triedIndices = new Set()
) {
  if (GROQ_API_KEYS.length === 0) {
    throw new Error(
      "GROQ API key belum dikonfigurasi."
    );
  }

  const keyIndex = pickKeyIndex(triedIndices);

  if (keyIndex === null) {
    throw new Error(
      "Semua Groq API key gagal, invalid, atau kena rate limit."
    );
  }

  const apiKey =
    GROQ_API_KEYS[keyIndex];

  console.log(
    `Chat pakai Groq key ${
      keyIndex + 1
    }/${GROQ_API_KEYS.length}`
  );

  let response;

  try {
    response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Authorization":
            "Bearer " + apiKey
        },

        body: JSON.stringify({
          model: modelId,
          messages,
          stream: true,
          max_tokens: maxTokens,
          temperature: 0.2
        })
      }
    );
  } catch (error) {
    console.error(
      `Groq network error key ${keyIndex + 1}:`,
      error
    );

    const nextTried =
      new Set(triedIndices);

    nextTried.add(keyIndex);

    if (
      nextTried.size >=
      GROQ_API_KEYS.length
    ) {
      throw error;
    }

    // LANGSUNG PINDAH KEY.
    // Tidak ada sleep.
    return callGroq(
      messages,
      modelId,
      maxTokens,
      nextTried
    );
  }

  // =======================================================
  // 401 = API KEY INVALID
  // =======================================================

  if (response.status === 401) {
    console.log(
      `Groq key ${
        keyIndex + 1
      } invalid, ditandai skip.`
    );

    invalidKeyIndices.add(keyIndex);

    const nextTried =
      new Set(triedIndices);

    nextTried.add(keyIndex);

    if (
      nextTried.size >=
      GROQ_API_KEYS.length
    ) {
      return response;
    }

    // LANGSUNG PINDAH KEY
    return callGroq(
      messages,
      modelId,
      maxTokens,
      nextTried
    );
  }

  // =======================================================
  // 429 = RATE LIMIT
  // =======================================================

  if (response.status === 429) {
    const errorText =
      await response
        .clone()
        .text()
        .catch(() => "");

    const retryAfterSeconds =
      parseRetryAfterSeconds(
        response,
        errorText
      );

    // -----------------------------------------------------
    // REQUEST TERLALU BESAR
    // -----------------------------------------------------

    if (
      errorText.includes(
        "output tokens per minute"
      ) ||
      errorText.includes("Requested")
    ) {
      console.log(
        "Groq: output token terlalu besar."
      );

      return response;
    }

    console.log(
      `Groq key ${
        keyIndex + 1
      } terkena rate limit.` +
        (
          retryAfterSeconds !== null
            ? ` Retry-After: ${retryAfterSeconds}s`
            : ""
        )
    );

    const nextTried =
      new Set(triedIndices);

    nextTried.add(keyIndex);

    // -----------------------------------------------------
    // MASIH ADA KEY LAIN
    // -----------------------------------------------------

    if (
      nextTried.size 
      GROQ_API_KEYS.length
    ) {
      // Tidak sleep.
      // Langsung coba key berikutnya.
      return callGroq(
        messages,
        modelId,
        maxTokens,
        nextTried
      );
    }

    // -----------------------------------------------------
    // SEMUA KEY KENA 429
    // -----------------------------------------------------

    if (
      retryAfterSeconds !== null
    ) {
      // Simpan Retry-After agar frontend
      // bisa mengetahui kapan sebaiknya mencoba lagi.
      response.headers.set(
        "x-groq-retry-after",
        String(retryAfterSeconds)
      );
    }

    return response;
  }

  // =======================================================
  // SUKSES
  // =======================================================

  if (response.ok) {
    nextKeyIndex =
      (keyIndex + 1) %
      GROQ_API_KEYS.length;

    return response;
  }

  // =======================================================
  // ERROR LAIN
  // =======================================================

  return response;
}

// =========================================================
// CLEAN MESSAGE
// =========================================================

function cleanMessages(messages) {
  return messages
    .filter((message) => {
      if (!message) return false;

      if (
        !["user", "assistant"].includes(
          message.role
        )
      ) {
        return false;
      }

      if (
        typeof message.content === "string"
      ) {
        return (
          message.content.trim() !== ""
        );
      }

      if (
        Array.isArray(message.content)
      ) {
        return message.content.length > 0;
      }

      return false;
    })

    .map((message) => {
      if (
        typeof message.content === "string"
      ) {
        return {
          role: message.role,
          content:
            message.content.trim()
        };
      }

      return {
        role: message.role,
        content: message.content
      };
    });
}

// =========================================================
// DOCUMENT
// =========================================================

function containsDocument(content) {
  if (typeof content !== "string") {
    return false;
  }

  return (
    content.includes("[Isi file") ||
    content.includes('[File "') ||
    content.includes("--- Sheet:") ||
    content.includes("--- Halaman")
  );
}

// =========================================================
// DOCUMENT NAME
// =========================================================

function getDocumentName(content) {
  if (typeof content !== "string") {
    return "dokumen";
  }

  const match =
    content.match(
      /\[Isi file "([^"]+)"\]/i
    ) ||
    content.match(
      /\[File "([^"]+)"\]/i
    );

  return match?.[1] || "dokumen";
}

// =========================================================
// DOCUMENT INSTRUCTION
// =========================================================

function buildDocumentInstruction(
  content
) {
  if (!containsDocument(content)) {
    return null;
  }

  const fileName =
    getDocumentName(content);

  return `
DOKUMEN USER

Nama file: ${fileName}

Gunakan dokumen sebagai sumber utama.
Jangan mengarang data.
`;
}

// =========================================================
// TRIM MESSAGE
// =========================================================

function trimMessagesForModel(
  messages
) {
  const imageIndices = [];

  messages.forEach(
    (message, index) => {
      if (messageHasImage(message)) {
        imageIndices.push(index);
      }
    }
  );

  const imageIndicesToStrip =
    new Set(
      imageIndices.slice(
        0,
        Math.max(
          0,
          imageIndices.length -
            MAX_IMAGE_MSGS_KEPT_FULL
        )
      )
    );

  const docIndices = [];

  messages.forEach(
    (message, index) => {
      if (
        typeof message.content ===
          "string" &&
        containsDocument(
          message.content
        )
      ) {
        docIndices.push(index);
      }
    }
  );

  // =======================================================
  // DOKUMEN: SEKALI PAKAI, TIDAK BERULANG
  // =======================================================
  // Sebelumnya dokumen bisa "bertahan" sampai beberapa
  // giliran chat (selama masih termasuk 1 dokumen paling
  // baru), sehingga isinya bisa terkirim ulang ke Groq
  // berkali-kali dan menguras kuota token harian (TPD).
  //
  // Sekarang: dokumen HANYA dikirim utuh kalau dia berada
  // di pesan PALING TERAKHIR (giliran chat yang sedang
  // berjalan). Begitu masuk giliran berikutnya, langsung
  // diganti placeholder — tidak ada toleransi sama sekali.

  const lastMessageIndex =
    messages.length - 1;

  const docIndicesToStrip =
    new Set(
      docIndices.filter(
        (index) =>
          index !== lastMessageIndex
      )
    );

  let trimmed = messages.map(
    (message, index) => {
      if (
        imageIndicesToStrip.has(index)
      ) {
        const textPart =
          Array.isArray(
            message.content
          )
            ? message.content.find(
                (part) =>
                  part &&
                  part.type === "text"
              )
            : null;

        const label =
          textPart?.text?.trim() ||
          "(Gambar terlampir)";

        return {
          role: message.role,
          content:
            label +
            "\n[Gambar lama tidak dikirim ulang]"
        };
      }

      if (
        docIndicesToStrip.has(index)
      ) {
        const fileName =
          getDocumentName(
            message.content
          );

        return {
          role: message.role,
          content:
            `[Dokumen "${fileName}" sudah dianalisis. Isi tidak dikirim ulang]`
        };
      }

      return message;
    }
  );

  if (
    trimmed.length >
    MAX_HISTORY_MESSAGES_FOR_MODEL
  ) {
    trimmed = trimmed.slice(
      trimmed.length -
        MAX_HISTORY_MESSAGES_FOR_MODEL
    );
  }

  return trimmed;
}

// =========================================================
// BUILD GROQ MESSAGE
// =========================================================

function normalizeMessageContent(
  content
) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part?.type === "text") {
          return part.text || "";
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return String(content ?? "");
}

// =========================================================
// SYSTEM PROMPT
// =========================================================

const SYSTEM_PROMPT_TEMPLATE =
  (memoryText) => `
Kamu Tanya, asisten AI spesialis LiDAR/GIS/terrain/hidrologi/data spasial, sekaligus asisten coding umum (semua bahasa pemrograman).

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

${memoryText}
`;

function buildGroqMessages(
  cleanMessages,
  memoryText,
  useVision
) {
  const result = [];

  result.push({
    role: "system",
    content:
      SYSTEM_PROMPT_TEMPLATE(
        memoryText
      )
  });

  for (const message of cleanMessages) {
    if (
      typeof message.content ===
      "string"
    ) {
      const documentInstruction =
        message.role === "user"
          ? buildDocumentInstruction(
              message.content
            )
          : null;

      if (documentInstruction) {
        result.push({
          role: "system",
          content:
            documentInstruction
        });
      }

      result.push({
        role: message.role,
        content: message.content
      });
    } else {
      if (
        useVision &&
        message ===
          cleanMessages[
            cleanMessages.length - 1
          ] &&
        Array.isArray(
          message.content
        )
      ) {
        result.push({
          role: message.role,
          content: message.content
        });
      } else {
        result.push({
          role: message.role,
          content:
            normalizeMessageContent(
              message.content
            )
        });
      }
    }
  }

  return result;
}

// =========================================================
// MAIN HANDLER
// =========================================================

export default async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    return res
      .status(405)
      .json({
        error: "Method not allowed"
      });
  }

  // =======================================================
  // AUTH HEADER
  // =======================================================

  const authHeader =
    req.headers.authorization || "";

  if (
    !authHeader.startsWith(
      "Bearer "
    )
  ) {
    return res
      .status(401)
      .json({
        error: "Belum login"
      });
  }

  const idToken =
    authHeader.substring(7).trim();

  // =======================================================
  // VERIFY AUTH
  // =======================================================

  let user;

  try {
    user =
      await verifyAuthToken(idToken);
  } catch (err) {
    console.error(
      "Auth error:",
      err
    );

    return res
      .status(401)
      .json({
        error:
          "Sesi login tidak valid atau sudah expired"
      });
  }

  const userId = user.userId;

  console.log(
    `User login: ${
      user.email || userId
    } | provider=${user.provider}`
  );

  // =======================================================
  // REQUEST BODY
  // =======================================================

  const {
    messages,
    conversationId,
    projectId
  } = req.body || {};

  if (
    !Array.isArray(messages) ||
    messages.length === 0
  ) {
    return res
      .status(400)
      .json({
        error: "Pesan kosong"
      });
  }

  const clean =
    cleanMessages(messages);

  const lastUserMessage =
    [...clean]
      .reverse()
      .find(
        (message) =>
          message.role === "user"
      );

  // =======================================================
  // CONVERSATION
  // =======================================================

  let convId = conversationId
    ? Number(conversationId)
    : null;

  if (!convId) {
    const title =
      lastUserMessage
        ? makeTitleFromMessage(
            typeof lastUserMessage.content ===
              "string"
              ? lastUserMessage.content
              : "Analisis gambar"
          )
        : "Percakapan baru";

    const conv =
      await createConversation(
        userId,
        title,
        projectId || null
      );

    convId = conv.id;
  }

  // =======================================================
  // MEMORY
  // =======================================================

  let memoryText =
    "Belum ada memory tersimpan.";

  try {
    const memories =
      await getMemories(userId);

    memoryText =
      formatMemoriesForPrompt(
        memories
      );

    console.log(
      `Memory ditemukan: ${memories.length} item`
    );
  } catch (err) {
    console.error(
      "Gagal ambil memories:",
      err
    );
  }

  if (
    memoryText.length >
    MAX_MEMORY_CHARS_IN_PROMPT
  ) {
    memoryText =
      memoryText.slice(
        0,
        MAX_MEMORY_CHARS_IN_PROMPT
      );

    const lastNewLine =
      memoryText.lastIndexOf(
        "\n"
      );

    if (lastNewLine > 0) {
      memoryText =
        memoryText.substring(
          0,
          lastNewLine
        );
    }

    memoryText +=
      "\n[Memory lama dipotong]";
  }

  console.log(
    "Memory dikirim ke AI:",
    memoryText
  );

  // =======================================================
  // VISION
  // =======================================================

  const useVision =
    !!lastUserMessage &&
    messageHasImage(
      lastUserMessage
    );

  const trimmedForModel =
    trimMessagesForModel(clean);

  let groqMessages =
    buildGroqMessages(
      trimmedForModel,
      memoryText,
      useVision
    );

  if (useVision) {
    groqMessages =
      capImagesPerRequest(
        groqMessages
      );
  }

  const modelToUse =
    useVision
      ? VISION_MODEL
      : MODEL;

  const maxOutputTokens =
    useVision
      ? 1000
      : 1200;

  // =======================================================
  // SAVE USER MESSAGE
  // =======================================================

  if (lastUserMessage) {
    const savedContent =
      typeof lastUserMessage.content ===
      "string"
        ? lastUserMessage.content
        : "[Lampiran gambar]";

    saveChatMessage(
      userId,
      convId,
      "user",
      savedContent
    ).catch(console.error);
  }

  // =======================================================
  // GROQ
  // =======================================================

  let upstream;

  try {
    upstream =
      await callGroq(
        groqMessages,
        modelToUse,
        maxOutputTokens
      );
  } catch (err) {
    console.error(
      "Groq error:",
      err
    );

    return res
      .status(502)
      .json({
        error:
          "Tidak dapat menghubungi AI"
      });
  }

  // =======================================================
  // GROQ ERROR
  // =======================================================

  if (
    !upstream.ok ||
    !upstream.body
  ) {
    const errorText =
      await upstream
        .text()
        .catch(() => "");

    console.error(
      "GROQ ERROR:",
      {
        status:
          upstream.status,
        body: errorText
      }
    );

    // -----------------------------------------------------
    // RATE LIMIT
    // -----------------------------------------------------

    if (
      upstream.status === 429
    ) {
      const retryAfter =
        parseRetryAfterSeconds(
          upstream,
          errorText
        );

      if (
        retryAfter !== null
      ) {
        res.setHeader(
          "Retry-After",
          String(retryAfter)
        );
      }

      return res
        .status(429)
        .json({
          error:
            retryAfter !== null
              ? `Semua Groq API key sedang terkena rate limit. Coba lagi dalam ${retryAfter} detik.`
              : "Semua Groq API key sedang terkena rate limit. Silakan coba lagi nanti.",

          code: "GROQ_RATE_LIMIT",

          retryAfter:
            retryAfter
      });
    }

    // -----------------------------------------------------
    // ERROR LAIN
    // -----------------------------------------------------

    return res
      .status(502)
      .json({
        error:
          errorText ||
          "Gagal mendapatkan respons dari AI.",

        code: "GROQ_ERROR"
      });
  }

  // =======================================================
  // SSE
  // =======================================================

  res.status(200);

  res.setHeader(
    "Content-Type",
    "text/event-stream; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-cache"
  );

  res.setHeader(
    "Connection",
    "keep-alive"
  );

  res.setHeader(
    "X-Conversation-Id",
    String(convId)
  );

  if (res.flushHeaders) {
    res.flushHeaders();
  }

  const reader =
    upstream.body.getReader();

  const decoder =
    new TextDecoder();

  let sseBuffer = "";
  let fullReply = "";

  // =======================================================
  // PROCESS SSE
  // =======================================================

  function processSSEChunk(
    chunkText
  ) {
    sseBuffer += chunkText;

    const lines =
      sseBuffer.split("\n");

    sseBuffer =
      lines.pop() ?? "";

    for (const line of lines) {
      const trimmed =
        line.trim();

      if (
        !trimmed.startsWith(
          "data:"
        )
      ) {
        continue;
      }

      const payload =
        trimmed
          .slice(5)
          .trim();

      if (
        payload === "[DONE]"
      ) {
        continue;
      }

      try {
        const json =
          JSON.parse(payload);

        const delta =
          json
            ?.choices?.[0]
            ?.delta?.content;

        if (
          typeof delta ===
          "string"
        ) {
          fullReply += delta;
        }
      } catch {
        // Abaikan SSE tidak valid.
      }
    }
  }

  // =======================================================
  // STREAM RESPONSE
  // =======================================================

  try {
    while (true) {
      const {
        done,
        value
      } =
        await reader.read();

      if (done) break;

      res.write(value);

      processSSEChunk(
        decoder.decode(
          value,
          {
            stream: true
          }
        )
      );
    }
  } catch (err) {
    console.error(
      "Streaming error:",
      err
    );
  }

  // =======================================================
  // SAVE ASSISTANT + EXTRACT MEMORY
  // =======================================================

  // SAVE ASSISTANT + EXTRACT MEMORY — jalan paralel, tidak menahan response
  if (fullReply.trim()) {
    saveChatMessage(userId, convId, "assistant", fullReply.trim())
      .catch((err) => console.error("Gagal simpan pesan assistant:", err));
  }

  if (lastUserMessage && typeof lastUserMessage.content === "string") {
    extractAndSaveFacts(userId, lastUserMessage.content)
      .catch((err) => console.error("Gagal ekstrak memory:", err));
  }

  res.end();
}
