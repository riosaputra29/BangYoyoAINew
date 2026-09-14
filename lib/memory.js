import { sql } from "./db.js";

export async function getMemories(userId) {
  return await sql`
    SELECT id, user_id, key, value, created_at, updated_at
    FROM memories
    WHERE user_id = ${userId}
    ORDER BY
      CASE
        WHEN key IN ('nama','bahasa','pekerjaan','lokasi') THEN 0
        ELSE 1
      END,
      updated_at DESC
    LIMIT 20
  `;
}

// VERSI BARU: ANTI RACE CONDITION + ANTI GAGAL
export async function upsertMemory(userId, key, value) {
  try {
    await sql`
      INSERT INTO memories (user_id, key, value, created_at, updated_at)
      VALUES (${userId}, ${key}, ${value}, now(), now())
      ON CONFLICT (user_id, key)
      DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = now()
    `;
    console.log(`Memory tersimpan: ${key} = ${value}`);
  } catch (err) {
    console.error("Gagal upsert memory:", err.message, err);
  }
}

export async function deleteMemory(userId, key) {
  await sql`DELETE FROM memories WHERE user_id = ${userId} AND key = ${key}`;
}

// UDAH DIUPDATE: PRIORITASKAN YANG PENTING + HAPUS DUPLIKAT
export function formatMemoriesForPrompt(memories) {
  if (memories.length === 0) return "Belum ada memory tersimpan untuk user ini.";

  // Ambil yg terbaru per key
  const map = new Map();
  memories.forEach(m => {
    if(!map.has(m.key)) map.set(m.key, m.value);
  });

  const penting = [];
  const lain = [];

  for(const [k, v] of map){
    const line = `- ${k}: ${v}`;
    if(['nama','bahasa','pekerjaan','lokasi'].includes(k)){
      penting.push(line);
    } else {
      lain.push(line);
    }
  }

  let result = "[MEMORY USER]\n";
  if(penting.length) result += penting.join("\n") + "\n";
  if(lain.length) result += lain.slice(0,5).join("\n"); // max 5 biar hemat token

  return result.trim();
}

// ====== CONVERSATIONS ======
export async function createConversation(userId, title = "Percakapan baru") {
  const rows = await sql`
    INSERT INTO conversations (user_id, title)
    VALUES (${userId}, ${title})
    RETURNING id, user_id, title, created_at, updated_at
  `;
  return rows[0];
}

export async function getConversations(userId) {
  return await sql`
    SELECT id, title, created_at, updated_at
    FROM conversations
    WHERE user_id = ${userId}
    ORDER BY updated_at DESC
  `;
}

export async function deleteConversation(userId, conversationId) {
  await sql`DELETE FROM chat_history WHERE user_id = ${userId} AND conversation_id = ${conversationId}`;
  const rows = await sql`DELETE FROM conversations WHERE id = ${conversationId} AND user_id = ${userId} RETURNING id`;
  return rows.length > 0;
}

async function touchConversation(conversationId) {
  await sql`UPDATE conversations SET updated_at = now() WHERE id = ${conversationId}`;
}

export function makeTitleFromMessage(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "Percakapan baru";
  return clean.length > 42? clean.slice(0, 42) + "…" : clean;
}

// ====== CHAT HISTORY ======
export async function saveChatMessage(userId, conversationId, role, content) {
  await sql`
    INSERT INTO chat_history (user_id, conversation_id, role, content, created_at)
    VALUES (${userId}, ${conversationId}, ${role}, ${content}, now())
  `;
  await touchConversation(conversationId);
}

export async function getChatHistory(userId, conversationId, limit = 200) {
  return await sql`
    SELECT id, user_id, conversation_id, role, content, created_at
    FROM chat_history
    WHERE user_id = ${userId} AND conversation_id = ${conversationId}
    ORDER BY id ASC
    LIMIT ${limit}
  `;
}
