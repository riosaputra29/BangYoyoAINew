
import { OAuth2Client } from "google-auth-library";
import { sql } from "../../lib/db.js";

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

    const projectId =
      Number(req.query.id);


    if (!Number.isInteger(projectId)) {

      return res.status(400).json({
        success: false,
        error: "Project ID tidak valid"
      });

    }


    if (req.method === "DELETE") {

      const rows = await sql`
        DELETE FROM projects
        WHERE id = ${projectId}
          AND user_id = ${userId}
        RETURNING id
      `;


      if (rows.length === 0) {

        return res.status(404).json({
          success: false,
          error: "Project tidak ditemukan"
        });

      }


      return res.status(200).json({
        success: true
      });

    }


    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });


  } catch (error) {

    console.error(
      "PROJECT DELETE ERROR:",
      error
    );

    return res.status(401).json({
      success: false,
      error: error.message
    });

  }

}
