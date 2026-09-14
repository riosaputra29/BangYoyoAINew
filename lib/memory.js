import { sql } from "./db.js";

export async function getMemories(userId) {
  return await sql`
    SELECT id, user_id, key, value
    FROM memories
    WHERE user_id = ${userId}
    ORDER BY
      CASE
        WHEN key IN ('nama','bahasa','pekerjaan','lokasi') THEN 0
        ELSE 1
      END,
      id DESC
    LIMIT 20
  `;
}

export async function upsertMemory(userId, key, value) {
  const existing = await sql`
    SELECT id FROM memories WHERE user_id = ${userId} 
  `;
  if (existing.length > 0) {
    await sql`UPDATE memories SET value = ${value}, updated_at = now() WHERE id = ${existing[0].id}`;
  } else {
    await sql`INSERT INTO memories (user_id, key, value) VALUES (${userId}, ${key}, ${value})`;
  }
  console.log(`Memory tersimpan: ${key} = ${value}`); // buat debug
}

export async function deleteMemory(userId, key) {
  await sql`DELETE FROM memories WHERE user_id = ${userId} AND key = ${key}`;
}

// UDAH DIUPDATE: PRIORITASKAN YANG PENTING
export function formatMemoriesForPrompt(memories) {
  if (memories.length === 0) return "Belum ada memory tersimpan untuk user ini.";

  const penting = [];
  const lain = [];

  for(const m of memories){
    const line = `- ${m.key}: ${m.value}`;
    if(['nama','bahasa','pekerjaan','lokasi'].includes(m.key)){
      penting.push(line);
    } else {
      lain.push(line);
    }
  }

  let result = "";
  if(penting.length) result += "[MEMORY PENTING]\n" + penting.join("\n") + "\n";
  if(lain.length) result += "[MEMORY LAIN]\n" + lain.slice(0,8).join("\n"); // max 8 biar hemat

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
