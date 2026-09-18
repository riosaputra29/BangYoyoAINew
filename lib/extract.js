import { upsertMemory } from "./memory.js";

const GROQ_API_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3,
  process.env.GROQ_KEY_4
].filter(Boolean);

let currentKeyIndex = 0;

const EXTRACT_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const MAX_GROQ_RETRIES = Math.max(GROQ_API_KEYS.length, 1);

const EXTRACTOR_SYSTEM_PROMPT = `Kamu adalah modul ekstraksi memory untuk sebuah chatbot.
Tugasmu: baca pesan user, lalu tentukan apakah ada fakta pribadi yang
layak diingat jangka panjang (nama, bahasa, pekerjaan, lokasi, hobi, dsb).

ATURAN:
- Balas HANYA dengan JSON array, tanpa teks lain, tanpa markdown fence.
- Setiap item: { "key": "...", "value": "..." }
- "key" wajib pakai ini: "nama", "bahasa", "pekerjaan", "lokasi", "hobi"
- Kalau tidak ada fakta baru yang layak disimpan, balas: []
- JANGAN simpan informasi sensitif.`;

// =========================================================
// GATE 1: PANJANG PESAN MINIMAL
// =========================================================
// Pesan super pendek ("ok", "makasih", "lanjut", "ya") hampir
// mustahil mengandung fakta pribadi baru. Skip duluan biar
// tidak buang API call untuk hal sepele.

const MIN_MESSAGE_LENGTH = 8;

// =========================================================
// GATE 2: KATA KUNCI SINYAL "PERSONAL"
// =========================================================
// Kalau tidak ada satupun kata ini, kemungkinan besar pesan
// adalah pertanyaan teknis/LiDAR/kode/dsb yang tidak relevan
// untuk ekstraksi fakta pribadi user. AI extraction di-skip.

const PERSONAL_SIGNAL_REGEX =
  /\b(nama|panggil|aku|saya|gw|gue|kerja|bekerja|profesi|jualan|usaha|tinggal|domisili|asal|dari kota|kota|suka|hobi|bahasa inggris|bahasa indonesia|bahasa jawa|umur|usia)\b/i;

// =========================================================
// GATE 3: SINYAL "JELAS BUKAN PERSONAL" (TEKNIS/DOMAIN KERJA)
// =========================================================
// Kalau pesan didominasi istilah teknis LiDAR/GIS/coding,
// kemungkinan besar bukan tentang data diri user meskipun
// kebetulan mengandung kata seperti "saya" atau "kerja".
// Dipakai sebagai penolak akhir sebelum manggil AI.

const TECHNICAL_DOMINANT_REGEX =
  /\b(lidar|dtm|dem|dsm|point cloud|las|laz|slope|aspect|elevasi|drainase|drainage|watershed|kontur|query|sql|javascript|python|function|script|error|deploy|vercel|api key|json|csv|excel|xlsx)\b/i;

function hasPersonalSignal(message) {
  if (typeof message !== "string") return false;

  const trimmed = message.trim();
  if (trimmed.length < MIN_MESSAGE_LENGTH) return false;

  if (!PERSONAL_SIGNAL_REGEX.test(trimmed)) return false;

  // Kalau sinyal teknis jauh mendominasi (banyak istilah teknis
  // sementara sinyal personal cuma nyempil), lebih baik skip.
  const technicalMatches =
    trimmed.match(TECHNICAL_DOMINANT_REGEX)?.length || 0;

  if (technicalMatches >= 3) return false;

  return true;
}

// =========================================================
// FALLBACK REGEX (SELALU DICOBA DULUAN — GRATIS, TANPA API)
// =========================================================

function extractFactsFallback(userMessage) {
  const facts = [];

  const nameMatch = userMessage.match(
    /(?:namaku|nama saya|panggil aku|panggil saya)\s+([A-Za-z]{2,20})/i
  );
  if (nameMatch) facts.push({ key: "nama", value: nameMatch[1] });

  if (/bahasa inggris/i.test(userMessage)) facts.push({ key: "bahasa", value: "Inggris" });
  if (/bahasa indonesia/i.test(userMessage)) facts.push({ key: "bahasa", value: "Indonesia" });
  if (/bahasa jawa/i.test(userMessage)) facts.push({ key: "bahasa", value: "Jawa" });

  const jobMatch = userMessage.match(
    /(?:kerja sebagai|bekerja sebagai|profesi(?:ku|nya)?\s+(?:adalah)?)\s+(.{3,50})/i
  );
  if (jobMatch) facts.push({ key: "pekerjaan", value: jobMatch[1].trim() });

  const locationMatch = userMessage.match(
    /(?:tinggal di|domisili di|asal dari|saya dari)\s+([A-Za-z\s]{3,40})/i
  );
  if (locationMatch) facts.push({ key: "lokasi", value: locationMatch[1].trim() });

  if (facts.length > 0) console.log("Extract Fallback hasil:", facts);
  return facts;
}

// =========================================================
// GROQ CALL (AI EXTRACTION — HANYA DIPANGGIL KALAU PERLU)
// =========================================================

async function callGroqExtract(messages, attempt = 0) {
  if (GROQ_API_KEYS.length === 0) {
    console.error("GROQ API key kosong semua");
    return null;
  }

  const apiKey = GROQ_API_KEYS[currentKeyIndex];
  console.log(`Extract pakai Groq key ${currentKeyIndex + 1}/${GROQ_API_KEYS.length}`);

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: EXTRACT_MODEL,
      stream: false,
      max_tokens: 200,
      temperature: 0,
      messages,
    }),
  });

  if (response.status === 429) {
    console.log(`Groq key ${currentKeyIndex + 1} kena rate limit extract`);
    if (attempt + 1 >= MAX_GROQ_RETRIES) {
      console.error("Semua Groq API key extract kena limit");
      return null;
    }
    currentKeyIndex = (currentKeyIndex + 1) % GROQ_API_KEYS.length;
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    return callGroqExtract(messages, attempt + 1);
  }

  return response;
}

async function extractFactsWithAI(userMessage) {
  try {
    const messages = [
      { role: "system", content: EXTRACTOR_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ];

    const response = await callGroqExtract(messages);
    if (!response || !response.ok) return [];

    const data = await response.json();
    let text = data?.choices?.[0]?.message?.content || "";
    text = text.replace(/```json|```/g, "").trim();

    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];

    console.log("Extract AI hasil:", parsed);
    return parsed.filter(
      (item) => typeof item.key === "string" && typeof item.value === "string"
    );
  } catch (err) {
    console.error("Gagal ekstrak fakta AI:", err.message);
    return [];
  }
}

// =========================================================
// MAIN: EXTRACT + SAVE
// =========================================================
// Urutan baru:
// 1. Regex fallback dicoba DULU — tanpa biaya API sama sekali.
// 2. Kalau regex sudah dapat fakta, LANGSUNG simpan & STOP.
//    (Tidak perlu manggil AI lagi buat konfirmasi ulang.)
// 3. AI extraction cuma dipanggil kalau regex kosong DAN
//    pesan lolos gate personal-signal (bukan pertanyaan
//    teknis, cukup panjang, ada sinyal personal).

export async function extractAndSaveFacts(userId, userMessage) {
  if (typeof userMessage !== "string" || !userMessage.trim()) {
    return;
  }

  // Langkah 1: coba regex dulu, gratis.
  let facts = extractFactsFallback(userMessage);

  // Langkah 2: kalau regex nemu sesuatu, tidak usah panggil AI.
  if (facts.length === 0) {

    // Langkah 3: hanya escalate ke AI kalau pesan memang
    // "berbau" personal. Pertanyaan teknis/kode/LiDAR dsb
    // di-skip total, hemat 1 API call penuh.
    if (hasPersonalSignal(userMessage)) {
      facts = await extractFactsWithAI(userMessage);
    }
  }

  for (const fact of facts) {
    await upsertMemory(userId, fact.key, fact.value);
  }
}
