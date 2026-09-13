import { sql } from "./db.js";

export async function getMemories(userId) {
  return await sql`
    SELECT id, user_id, key, value
    FROM memories
    WHERE user_id = ${userId}
    ORDER BY id ASC
  `;
}

export async function upsertMemory(userId, key, value) {
  const existing = await sql`
    SELECT id FROM memories WHERE user_id = ${userId} AND key = ${key}
  `;
  if (existing.length > 0) {
    await sql`UPDATE memories SET value = ${value} WHERE id = ${existing[0].id}`;
  } else {
    await sql`INSERT INTO memories (user_id, key, value) VALUES (${userId}, ${key}, ${value})`;
  }
}

export async function deleteMemory(userId, key) {
  await sql`DELETE FROM memories WHERE user_id = ${userId} AND key = ${key}`;
}

export function formatMemoriesForPrompt(memories) {
  if (memories.length === 0) return "Belum ada memory tersimpan untuk user ini.";
  return memories.map((m) => `- ${m.key}: ${m.value}`).join("\n");
}

// ====== CONVERSATIONS (tabel: conversations) ======
// [MEMORY] Satu user bisa punya banyak percakapan terpisah, ditampilkan
// semuanya di sidebar "Chats and tasks".

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
  // Hapus semua pesan dalam percakapan
  await sql`
    DELETE FROM chat_history
    WHERE user_id = ${userId}
      AND conversation_id = ${conversationId}
  `;

  // Hapus percakapannya
  const rows = await sql`
    DELETE FROM conversations
    WHERE id = ${conversationId}
      AND user_id = ${userId}
    RETURNING id
  `;

  return rows.length > 0;
}

async function touchConversation(conversationId) {
  await sql`UPDATE conversations SET updated_at = now() WHERE id = ${conversationId}`;
}

// Judul otomatis dari pesan pertama user, dipotong biar muat di sidebar.
export function makeTitleFromMessage(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "Percakapan baru";
  return clean.length > 42 ? clean.slice(0, 42) + "…" : clean;
}

// ====== CHAT HISTORY (tabel: chat_history, sekarang per conversation) ======

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
