import { verifyTanyaToken } from "../../lib/auth.js";

export const runtime = "nodejs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  const token = String(req.query?.token || "");

  if (!token) {
    return res.status(400).send("Magic link tidak lengkap.");
  }

  try {
    const data = await verifyTanyaToken(token);

    if (
      data.type !== "magic" ||
      !data.email ||
      !data.userId
    ) {
      throw new Error("Invalid magic token");
    }

    const origin =
      process.env.APP_URL ||
      `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;

    return res.redirect(
      302,
      `${origin}/?magic_token=${encodeURIComponent(token)}`
    );

  } catch (error) {

    console.error("VERIFY MAGIC LINK ERROR:", error);

    return res.status(401).send(`
      <!doctype html>

      <html lang="id">

      <head>
        <meta charset="utf-8">
        <title>Magic Link Tidak Valid</title>
      </head>

      <body style="
        font-family:Arial,sans-serif;
        background:#111;
        color:#fff;
        display:grid;
        place-items:center;
        min-height:100vh;
        margin:0;
      ">

        <div style="
          max-width:460px;
          text-align:center;
          padding:30px;
        ">

          <h2>Link login tidak valid</h2>

          <p style="
            color:#bbb;
            line-height:1.6;
          ">
            Link mungkin sudah kedaluwarsa atau tidak valid.
            Silakan kembali ke Tanya dan kirim magic link baru.
          </p>

          <a
            href="/"
            style="
              color:#e8c77a;
              text-decoration:none;
            "
          >
            Kembali ke Tanya
          </a>

        </div>

      </body>

      </html>
    `);
  }
}
