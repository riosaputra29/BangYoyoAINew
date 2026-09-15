import crypto from "crypto";

export const runtime = "nodejs";

function verifyMagicToken(token) {
  const secret = process.env.MAGIC_LINK_SECRET;

  if (!secret) {
    throw new Error("MAGIC_LINK_SECRET belum diset.");
  }

  const parts = String(token).split(".");

  if (parts.length !== 2) {
    throw new Error("Format token tidak valid.");
  }

  const [payloadEncoded, signature] = parts;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payloadEncoded)
    .digest("base64url");

  if (
    !crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    )
  ) {
    throw new Error("Signature token tidak valid.");
  }

  const payload = JSON.parse(
    Buffer.from(payloadEncoded, "base64url").toString("utf8")
  );

  if (payload.type !== "magic") {
    throw new Error("Token bukan magic link.");
  }

  if (!payload.email || !payload.userId) {
    throw new Error("Data token tidak lengkap.");
  }

  const now = Math.floor(Date.now() / 1000);

  if (!payload.exp || now > payload.exp) {
    throw new Error("Magic link sudah kedaluwarsa.");
  }

  return payload;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  const token = String(req.query?.token || "");

  if (!token) {
    return res.status(400).send("Magic link tidak lengkap.");
  }

  try {
    verifyMagicToken(token);

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

          <p style="color:#bbb;line-height:1.6">
            Link mungkin sudah kedaluwarsa atau tidak valid.
            Silakan kembali ke Tanya dan kirim magic link baru.
          </p>

          <a
            href="/"
            style="color:#e8c77a;text-decoration:none"
          >
            Kembali ke Tanya
          </a>

        </div>

      </body>
      </html>
    `);
  }
}
