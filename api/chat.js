import { OAuth2Client } from "google-auth-library";
import {
  getMemories,
  formatMemoriesForPrompt,
  saveChatMessage,
  createConversation,
  makeTitleFromMessage
} from "../lib/memory.js";
import { extractAndSaveFacts } from "../lib/extract.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const GROQ_API_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3,
  process.env.GROQ_KEY_4
].filter(Boolean);

let currentKeyIndex = 0;

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";

const MAX_IMAGES_PER_REQUEST = 5;
const MAX_GROQ_RETRIES = Math.max(GROQ_API_KEYS.length, 1);

// TOKEN SAVING
const MAX_HISTORY_MESSAGES_FOR_MODEL = 2; // naikin dikit biar context ga ilang
const MAX_DOCS_KEPT_FULL = 1;
const MAX_IMAGE_MSGS_KEPT_FULL = 1;
const MAX_MEMORY_CHARS_IN_PROMPT = 1000;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

async function verifyGoogleToken(idToken) {
  const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload) throw new Error("Payload Google tidak ditemukan.");
  return payload;
}

function messageHasImage(message) {
  if (!message ||!Array.isArray(message.content)) return false;
  return message.content.some((part) => part && part.type === "image_url");
}

function capImagesPerRequest(messages, maxImages = MAX_IMAGES_PER_REQUEST) {
  let imageCount = 0;
  const reversed = [...messages].reverse();
  const capped = reversed.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const newContent = message.content.filter((part) => {
      if (part && part.type === "image_url") {
        imageCount++;
        return imageCount <= maxImages;
      }
      return true;
    });
    return {...message, content: newContent };
  });
  return capped.reverse();
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function callGroq(messages, modelId, maxTokens, attempt = 0) {
  if (GROQ_API_KEYS.length === 0) return Promise.reject(new Error("GROQ API key belum dikonfigurasi."));
  const apiKey = GROQ_API_KEYS[currentKeyIndex];
  console.log(`Chat pakai Groq key ${currentKeyIndex + 1}/${GROQ_API_KEYS.length}`);

  return fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
    body: JSON.stringify({ model: modelId, messages, stream: true, max_tokens: maxTokens, temperature: 0.2 }),
  }).then(async (response) => {
    if (response.status === 429) {
      console.log(`Groq key ${currentKeyIndex + 1} kena rate limit`);
      if (attempt + 1 >= MAX_GROQ_RETRIES) return response;
      currentKeyIndex = (currentKeyIndex + 1) % GROQ_API_KEYS.length;
      await sleep(300 * (attempt + 1));
      return callGroq(messages, modelId, maxTokens, attempt + 1);
    }
    return response;
  });
}

function cleanMessages(messages) {
  return messages.filter((message) => {
      if (!message) return false;
      if (!["user", "assistant"].includes(message.role)) return false;
      if (typeof message.content === "string") return message.content.trim()!== "";
      if (Array.isArray(message.content)) return message.content.length > 0;
      return false;
    }).map((message) => {
      if (typeof message.content === "string") return { role: message.role, content: message.content.trim() };
      return { role: message.role, content: message.content };
    });
}

function containsDocument(content) {
  if (typeof content!== "string") return false;
  return content.includes("[Isi file") || content.includes("[File \"") || content.includes("--- Sheet:") || content.includes("--- Halaman");
}

function getDocumentName(content) {
  if (typeof content!== "string") return "dokumen";
  const match = content.match(/\[Isi file "([^"]+)"\]/i) || content.match(/\[File "([^"]+)"\]/i);
  return match?.[1] || "dokumen";
}

function buildDocumentInstruction(content) {
  if (!containsDocument(content)) return null;
  const fileName = getDocumentName(content);
  return `\nDOKUMEN USER\nNama file: ${fileName}\nGunakan dokumen sebagai sumber utama. Jangan mengarang data.`;
}

function trimMessagesForModel(messages) {
  const imageIndices = [];
  messages.forEach((message, index) => { if (messageHasImage(message)) imageIndices.push(index); });
  const imageIndicesToStrip = new Set(imageIndices.slice(0, Math.max(0, imageIndices.length - MAX_IMAGE_MSGS_KEPT_FULL)));

  const docIndices = [];
  messages.forEach((message, index) => { if (typeof message.content === "string" && containsDocument(message.content)) docIndices.push(index); });
  const docIndicesToStrip = new Set(docIndices.slice(0, Math.max(0, docIndices.length - MAX_DOCS_KEPT_FULL)));

  let trimmed = messages.map((message, index) => {
    if (imageIndicesToStrip.has(index)) {
      const textPart = Array.isArray(message.content)? message.content.find((part) => part && part.type === "text") : null;
      const label = textPart?.text?.trim() || "(Gambar terlampir)";
      return { role: message.role, content: label + "\n[Gambar lama tidak dikirim ulang]" };
    }
    if (docIndicesToStrip.has(index)) {
      const fileName = getDocumentName(message.content);
      return { role: message.role, content: `[Dokumen "${fileName}" sudah dianalisis. Isi tidak dikirim ulang]` };
    }
    return message;
  });

  if (trimmed.length > MAX_HISTORY_MESSAGES_FOR_MODEL) trimmed = trimmed.slice(trimmed.length - MAX_HISTORY_MESSAGES_FOR_MODEL);
  return trimmed;
}

function buildGroqMessages(cleanMessages, memoryText, useVision) {
  const result = [];
  result.push({
    role: "system",
    content: `Kamu adalah Tanya, asisten AI yang cerdas, ramah, teliti, dan natural.
ATURAN UTAMA: Utamakan akurasi. Jangan mengarang. Jika tidak tau, katakan.
BAHASA: Gunakan Bahasa Indonesia default. Ikuti bahasa user.
GAYA: Singkat kalau bisa. Gunakan heading, bullet, tabel bila perlu.
MARKDOWN: Gunakan dengan valid.
MATEMATIKA: Gunakan LaTeX $...$ atau $$...$$
KODE: Jelaskan masalah -> penyebab -> kode benar -> perubahan.
DOKUMEN: Gunakan sebagai sumber utama. Jangan karang.
GAMBAR: ${useVision? "Analisis isi gambar yg terlihat. Jangan mengarang." : ""}

ATURAN MEMORY YANG WAJIB:
Jika di bawah ini ada "nama", maka WAJIB panggil user dengan nama itu di setiap jawaban. Jangan pernah tanya "siapa nama kamu" lagi.

MEMORY USER:
${memoryText}
EXPORT EXCEL: Hanya jika user minta file Excel. Kasih code block csv.`
  });

  for (const message of cleanMessages) {
    if (typeof message.content === "string") {
      const documentInstruction = message.role === "user"? buildDocumentInstruction(message.content) : null;
      if (documentInstruction) result.push({ role: "system", content: documentInstruction });
      result.push({ role: message.role, content: message.content });
    } else {
      result.push({ role: message.role, content: message.content });
    }
  }
  return result;
}

export default async function handler(req, res) {
  if (req.method!== "POST") return res.status(405).json({ error: "Method not allowed" });

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "Belum login dengan Google." });
  const idToken = authHeader.substring(7).trim();

  let userId;
  try {
    const googleUser = await verifyGoogleToken(idToken);
    console.log(`Google login: ${googleUser.email || "unknown"}`);
    userId = googleUser.sub;
  } catch (err) {
    console.error("Google verification error:", err.message);
    return res.status(401).json({ error: "Sesi Google tidak valid atau sudah kedaluwarsa." });
  }

  const { messages, conversationId } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "Pesan kosong atau format salah." });

  const clean = cleanMessages(messages);
  if (clean.length === 0) return res.status(400).
