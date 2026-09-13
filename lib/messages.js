import { sql } from "./db.js";

export async function saveMessage(userId, role, content) {
  await sql`
    INSERT INTO messages (user_id, role, content, created_at)
    VALUES (${userId}, ${role}, ${content}, now())
  `;
}

export async function getRecentMessages(userId, limit = 20) {
  const rows = await sql`
    SELECT id, user_id, role, content, created_at
    FROM messages
    WHERE user_id = ${userId}
    ORDER BY id DESC
    LIMIT ${limit}
  `;
  return rows.reverse();
}
