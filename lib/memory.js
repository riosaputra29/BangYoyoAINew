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

  // Bersihkan key dan value
  const cleanKey = String(key || "")
    .trim()
    .toLowerCase();

  const cleanValue = String(value || "")
    .trim()
    .replace(/\s+/g, " ");

  // Jangan simpan memory kosong
  if (!cleanKey || !cleanValue) {
    return;
  }

  /*
   * MEMORY UTAMA
   *
   * Untuk key berikut, satu user hanya boleh
   * mempunyai satu memory aktif:
   *
   * nama
   * bahasa
   * pekerjaan
   * lokasi
   */
  const singleValueKeys = [
    "nama",
    "bahasa",
    "pekerjaan",
    "lokasi"
  ];

  if (singleValueKeys.includes(cleanKey)) {

    // Cari memory berdasarkan USER + KEY,
    // bukan berdasarkan VALUE.
    const existing = await sql`
      SELECT id
      FROM memories
      WHERE user_id = ${userId}
        AND key = ${cleanKey}
      ORDER BY id DESC
      LIMIT 1
    `;

    if (existing.length > 0) {

      // Update memory yang sudah ada
      await sql`
        UPDATE memories
        SET value = ${cleanValue}
        WHERE id = ${existing[0].id}
      `;

      /*
       * Bersihkan duplicate lama jika sebelumnya
       * sudah terlanjur ada lebih dari satu.
       */
      await sql`
        DELETE FROM memories
        WHERE user_id = ${userId}
          AND key = ${cleanKey}
          AND id <> ${existing[0].id}
      `;

    } else {

      // Belum ada → INSERT
      await sql`
        INSERT INTO memories (
          user_id,
          key,
          value
        )
        VALUES (
          ${userId},
          ${cleanKey},
          ${cleanValue}
        )
      `;
    }

  } else {

    /*
     * MEMORY LAIN
     *
     * Untuk memory selain nama/bahasa/pekerjaan/lokasi,
     * jangan simpan value yang sama dua kali.
     */
    const existing = await sql`
      SELECT id
      FROM memories
      WHERE user_id = ${userId}
        AND key = ${cleanKey}
        AND LOWER(TRIM(value)) = LOWER(TRIM(${cleanValue}))
      LIMIT 1
    `;

    if (existing.length === 0) {

      await sql`
        INSERT INTO memories (
          user_id,
          key,
          value
        )
        VALUES (
          ${userId},
          ${cleanKey},
          ${cleanValue}
        )
      `;
    }
  }

  console.log(
    `Memory tersimpan: ${cleanKey} = ${cleanValue}`
  );
}

export async function deleteMemory(userId, key) {
  await sql`
    DELETE FROM memories
    WHERE user_id = ${userId}
      AND key = ${key}
  `;
}

// ====== FORMAT MEMORY UNTUK PROMPT ======

export function formatMemoriesForPrompt(memories) {

  if (memories.length === 0) {
    return "Belum ada memory tersimpan untuk user ini.";
  }

  const penting = [];
  const lain = [];

  for (const m of memories) {

    const line = `- ${m.key}: ${m.value}`;

    if (
      [
        "nama",
        "bahasa",
        "pekerjaan",
        "lokasi"
      ].includes(m.key)
    ) {
      penting.push(line);
    } else {
      lain.push(line);
    }
  }

  let result = "";

  if (penting.length) {
    result +=
      "[MEMORY PENTING]\n" +
      penting.join("\n") +
      "\n";
  }

  if (lain.length) {
    result +=
      "[MEMORY LAIN]\n" +
      lain.slice(0, 8).join("\n");
  }

  return result.trim();
}

// ====== CONVERSATIONS ======

export async function createConversation(
  userId,
  title = "Percakapan baru",
  projectId = null
) {
  const rows = await sql`
    INSERT INTO conversations (
      user_id,
      title,
      project_id
    )
    VALUES (
      ${userId},
      ${title},
      ${projectId}
    )
    RETURNING
      id,
      user_id,
      title,
      project_id,
      created_at,
      updated_at
  `;

  return rows[0];
}

export async function getConversations(userId, projectId = null) {

  if (projectId) {
    return await sql`
      SELECT
        id,
        title,
        project_id,
        created_at,
        updated_at
      FROM conversations
      WHERE user_id = ${userId}
        AND project_id = ${projectId}
      ORDER BY updated_at DESC
    `;
  }

  return await sql`
    SELECT
      id,
      title,
      project_id,
      created_at,
      updated_at
    FROM conversations
    WHERE user_id = ${userId}
    ORDER BY updated_at DESC
  `;
}

export async function deleteConversation(
  userId,
  conversationId
) {
  await sql`
    DELETE FROM chat_history
    WHERE user_id = ${userId}
      AND conversation_id = ${conversationId}
  `;

  const rows = await sql`
    DELETE FROM conversations
    WHERE id = ${conversationId}
      AND user_id = ${userId}
    RETURNING id
  `;

  return rows.length > 0;
}

async function touchConversation(conversationId) {
  await sql`
    UPDATE conversations
    SET updated_at = now()
    WHERE id = ${conversationId}
  `;
}

export function makeTitleFromMessage(text) {

  const clean = (text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) {
    return "Percakapan baru";
  }

  return clean.length > 42
    ? clean.slice(0, 42) + "…"
    : clean;
}

// ====== CHAT HISTORY ======

export async function saveChatMessage(
  userId,
  conversationId,
  role,
  content
) {
  await sql`
    INSERT INTO chat_history (
      user_id,
      conversation_id,
      role,
      content,
      created_at
    )
    VALUES (
      ${userId},
      ${conversationId},
      ${role},
      ${content},
      now()
    )
  `;

  await touchConversation(conversationId);
}

export async function getChatHistory(
  userId,
  conversationId,
  limit = 200
) {
  return await sql`
    SELECT
      id,
      user_id,
      conversation_id,
      role,
      content,
      created_at
    FROM chat_history
    WHERE user_id = ${userId}
      AND conversation_id = ${conversationId}
    ORDER BY id ASC
    LIMIT ${limit}
  `;
}
