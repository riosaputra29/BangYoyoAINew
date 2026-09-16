import { OAuth2Client } from "google-auth-library";
import { sql } from "../lib/db.js";

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID;

const googleClient =
  new OAuth2Client(GOOGLE_CLIENT_ID);


async function getUser(req) {

  const auth =
    req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    throw new Error("Unauthorized");
  }

  const token =
    auth.substring(7);

  const ticket =
    await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID
    });

  return ticket.getPayload();
}


export default async function handler(req, res) {

  try {

    const user =
      await getUser(req);

    const userId =
      user.sub;


    // =========================
    // GET PROJECTS
    // =========================

    if (req.method === "GET") {

      const projects = await sql`
        SELECT
          id,
          user_id,
          name,
          created_at,
          updated_at
        FROM projects
        WHERE user_id = ${userId}
        ORDER BY updated_at DESC, id DESC
      `;

      return res.status(200).json({
        success: true,
        projects
      });
    }


    // =========================
    // CREATE PROJECT
    // =========================

    if (req.method === "POST") {

      const name =
        String(req.body?.name || "")
          .trim();

      if (!name) {

        return res.status(400).json({
          success: false,
          error: "Nama project wajib diisi"
        });

      }


      if (name.length > 100) {

        return res.status(400).json({
          success: false,
          error: "Nama project maksimal 100 karakter"
        });

      }


      const rows = await sql`
        INSERT INTO projects (
          user_id,
          name
        )
        VALUES (
          ${userId},
          ${name}
        )
        RETURNING
          id,
          user_id,
          name,
          created_at,
          updated_at
      `;


      return res.status(201).json({
        success: true,
        project: rows[0]
      });
    }


    // =========================
    // DELETE PROJECT
    // =========================

    if (req.method === "DELETE") {

      const projectId =
        req.query?.projectId ||
        req.body?.projectId;

      if (!projectId) {

        return res.status(400).json({
          success: false,
          error: "projectId wajib diisi"
        });

      }


      // Lepaskan percakapan dari project ini —
      // percakapan tidak ikut terhapus, cuma jadi
      // percakapan biasa (project_id = null) lagi.
      await sql`
        UPDATE conversations
        SET project_id = NULL
        WHERE user_id = ${userId}
          AND project_id = ${Number(projectId)}
      `;


      const rows = await sql`
        DELETE FROM projects
        WHERE id = ${Number(projectId)}
          AND user_id = ${userId}
        RETURNING id
      `;


      if (rows.length === 0) {

        return res.status(404).json({
          success: false,
          error: "Project tidak ditemukan atau bukan milik user."
        });

      }


      return res.status(200).json({
        success: true,
        message: "Project berhasil dihapus."
      });
    }


    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });


  } catch (error) {

    console.error(
      "PROJECT API ERROR:",
      error
    );

    return res.status(401).json({
      success: false,
      error: error.message
    });

  }

}
