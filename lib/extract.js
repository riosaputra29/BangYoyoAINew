import { upsertMemory } from "./memory.js";

const GROQ_API_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3,
  process.env.GROQ_KEY_4
].filter(Boolean); // buang yg kosong

let currentKeyIndex = 0; // buat rotasi

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
    await new Promise(r => setTimeout(r, 300 * (attempt + 1))); // delay dikit
    return callGroqExtract(messages, attempt + 1);
  }

  return response;
}

async function extractFacts(userMessage) {
  try {
    const messages = [
      { role: "system", content: EXTRACTOR_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ];

    const response = await callGroqExtract(messages);
    if (!response ||!response.ok) return [];

    const data = await response.json();
    let text = data?.choices?.[0]?.message?.content || "";
    text = text.replace(/```json|```/g, "").trim();

    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];

    console.log("Extract AI hasil:", parsed);
    return parsed.filter((item) => typeof item.key === "string" && typeof item.value === "string");

  } catch (err) {
    console.error("Gagal ekstrak fakta AI:", err.message);
    return [];
  }
}

// FALLBACK REGEX BIAR AMAN
function extractFactsFallback(userMessage) {
  const facts = [];
  const nameMatch = userMessage.match(/(?:namaku|nama saya|panggil aku|aku|gw|saya)\s+([A-Za-z]{2,20})/i);
  if (nameMatch) facts.push({ key: "nama", value: nameMatch[1] });
  if (/bahasa inggris/i.test(userMessage)) facts.push({ key: "bahasa", value: "Inggris" });
  if (/bahasa indonesia/i.test(userMessage)) facts.push({ key: "bahasa", value: "Indonesia" });
  const jobMatch = userMessage.match(/(?:kerja|bekerja|jualan|usaha)\s+(.{3,50})/i);
  if (jobMatch) facts.push({ key: "pekerjaan", value: jobMatch[1].trim() });
  if(facts.length > 0) console.log("Extract Fallback hasil:", facts);
  return facts;
}

export async function extractAndSaveFacts(userId, userMessage) {
  let facts = await extractFacts(userMessage);

  // Kalau AI gagal/limit, pake fallback biar nama tetep kesimpan
  if(facts.length === 0){
    facts = extractFactsFallback(userMessage);
  }

  for (const fact of facts) {
    await upsertMemory(userId, fact.key, fact.value);
  }
}
