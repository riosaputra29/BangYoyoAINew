import { upsertMemory } from "./memory.js";

const GROQ_KEY_1 = process.env.GROQ_KEY_1;
const EXTRACT_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const EXTRACTOR_SYSTEM_PROMPT = `Kamu adalah modul ekstraksi memory untuk sebuah chatbot.
Tugasmu: baca pesan user, lalu tentukan apakah ada fakta pribadi yang
layak diingat jangka panjang (nama panggilan, preferensi, pekerjaan,
kota tinggal, hobi, dsb).

ATURAN:
- Balas HANYA dengan JSON array, tanpa teks lain, tanpa markdown fence.
- Setiap item: { "key": "...", "value": "..." }
- "key" singkat dan konsisten (snake_case), misal "panggilan", "kota",
  "pekerjaan", "hobi".
- Kalau tidak ada fakta baru yang layak disimpan, balas: []
- JANGAN simpan informasi sensitif: kesehatan, orientasi seksual,
  agama, keyakinan politik, data keuangan, nomor identitas.
- Fakta harus benar-benar dinyatakan user, jangan menebak/menyimpulkan.`;

async function extractFacts(userMessage) {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + GROQ_KEY_1,
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        stream: false,
        max_tokens: 300,
        messages: [
          { role: "system", content: EXTRACTOR_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      console.error("Groq extract error:", response.status, await response.text());
      return [];
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || "";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) => typeof item.key === "string" && typeof item.value === "string"
    );
  } catch (err) {
    // Kalau parsing/network gagal, jangan sampai bikin request utama gagal —
    // cukup skip penyimpanan memory kali ini.
    console.error("Gagal ekstrak fakta:", err);
    return [];
  }
}

export async function extractAndSaveFacts(userId, userMessage) {
  const facts = await extractFacts(userMessage);
  for (const fact of facts) {
    await upsertMemory(userId, fact.key, fact.value);
  }
}
