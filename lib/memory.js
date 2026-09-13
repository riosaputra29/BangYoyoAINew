import { sql } from "./db.js";

export async function getMemories(userId) {
  return await sql`
    SELECT id, user_id, key, value
    FROM memories
    WHERE user_id = ${userId}
    ORDER BY id ASC
  `;
}

/**
 * Simpan/update satu memory. Kalau mau lebih efisien, tambah unique
 * constraint di Neon SQL editor:
 *   ALTER TABLE memories ADD CONSTRAINT memories_user_key_unique
 *   UNIQUE (user_id, key);
 * lalu ganti fungsi ini pakai INSERT ... ON CONFLICT.
 */
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

// ====== CHAT HISTORY (tabel: chat_history) ======
// [MEMORY] Dipindah dari lib/messages.js dan digabung ke sini,
// supaya semua yang berhubungan dengan "apa yang AI ingat soal user"
// (memory jangka panjang + riwayat percakapan) ada di satu file.

export async function saveChatMessage(userId, role, content) {
  await sql`
    INSERT INTO chat_history (user_id, role, content, created_at)
    VALUES (${userId}, ${role}, ${content}, now())
  `;
}

// Ambil N pesan terakhir, dikembalikan urut dari yang PALING LAMA ke
// PALING BARU (ascending) — urutan ini yang paling gampang langsung
// dirender jadi bubble chat dari atas ke bawah tanpa perlu reverse lagi.
export async function getChatHistory(userId, limit = 50) {
  const rows = await sql`
    SELECT id, user_id, role, content, created_at
    FROM chat_history
    WHERE user_id = ${userId}
    ORDER BY id DESC
    LIMIT ${limit}
  `;
  return rows.reverse();
}
