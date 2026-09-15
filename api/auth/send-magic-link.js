import { signTanyaToken } from "../../lib/auth.js";

export const runtime = "nodejs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const email = String(
      req.body?.email || ""
    ).trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: "Email tidak valid."
      });
    }

    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY belum diset.");
    }

    if (!process.env.EMAIL_FROM) {
      throw new Error("EMAIL_FROM belum diset.");
    }

    if (!process.env.MAGIC_LINK_SECRET) {
      throw new Error("MAGIC_LINK_SECRET belum diset.");
    }

    const now = Math.floor(Date.now() / 1000);

    const token = await signTanyaToken({
      type: "magic",
      userId: `email:${email}`,
      email,
      iat: now,
      exp: now + 15 * 60
    });

    const origin =
      process.env.APP_URL ||
      `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;

    const link =
      `${origin}/api/auth/verify-magic-link?token=` +
      encodeURIComponent(token);

    const response = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          from: process.env.EMAIL_FROM,
          to: [email],
          subject: "Masuk ke Tanya AI",

          html: `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif">
  <h2>Masuk ke Tanya AI</h2>

  <p>Klik tombol di bawah untuk masuk ke akun Tanya.</p>

  <p>
    <a href="${link}"
       style="
       display:inline-block;
       padding:12px 20px;
       background:#c99b4a;
       color:#fff;
       text-decoration:none;
       border-radius:8px;">
       Masuk ke Tanya AI
    </a>
  </p>

  <p>Link berlaku selama 15 menit.</p>

  <p>Jika kamu tidak meminta login, abaikan email ini.</p>
</body>
</html>
`
        })
      }
    );

    if (!response.ok) {
      const detail = await response.text();

      console.error(
        "RESEND ERROR:",
        response.status,
        detail
      );

      return res.status(502).json({
        error: "Email gagal dikirim."
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Magic link berhasil dikirim."
    });

  } catch (error) {

    console.error(
      "SEND MAGIC LINK ERROR:",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "Terjadi kesalahan saat mengirim magic link."
    });
  }
}
