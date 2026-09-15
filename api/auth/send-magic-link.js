import crypto from "crypto";

export const runtime = "nodejs";

function createMagicToken(email) {
  const secret = process.env.MAGIC_LINK_SECRET;

  if (!secret) {
    throw new Error("MAGIC_LINK_SECRET belum diset di Vercel.");
  }

  const now = Math.floor(Date.now() / 1000);

  const payload = {
    type: "magic",
    email,
    userId: `email:${email}`,
    iat: now,
    exp: now + 15 * 60
  };

  const encodedPayload = Buffer
    .from(JSON.stringify(payload))
    .toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        error: "Email tidak valid."
      });
    }

    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({
        error: "RESEND_API_KEY belum diset di Vercel."
      });
    }

    if (!process.env.EMAIL_FROM) {
      return res.status(500).json({
        error: "EMAIL_FROM belum diset di Vercel."
      });
    }

    if (!process.env.MAGIC_LINK_SECRET) {
      return res.status(500).json({
        error: "MAGIC_LINK_SECRET belum diset di Vercel."
      });
    }

    const token = createMagicToken(email);

    const origin =
      process.env.APP_URL ||
      `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;

    const link =
      `${origin}/api/auth/verify-magic-link?token=` +
      encodeURIComponent(token);

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [email],
        subject: "Masuk ke Tanya AI",
        html: `
          <div style="
            font-family:Arial,sans-serif;
            max-width:560px;
            margin:40px auto;
            padding:32px;
            border:1px solid #e5e5e5;
            border-radius:18px;
          ">
            <h2>Masuk ke Tanya AI</h2>

            <p style="color:#666;line-height:1.6">
              Klik tombol di bawah untuk masuk tanpa password.
              Link ini berlaku selama 15 menit.
            </p>

            <p style="margin:28px 0">
              <a
                href="${link}"
                style="
                  display:inline-block;
                  background:#111;
                  color:#fff;
                  text-decoration:none;
                  padding:13px 22px;
                  border-radius:10px;
                "
              >
                Masuk ke Tanya
              </a>
            </p>

            <p style="font-size:12px;color:#999">
              Jika kamu tidak meminta login ini, abaikan email ini.
            </p>
          </div>
        `
      })
    });

    if (!response.ok) {
      const detail = await response.text();

      console.error("RESEND ERROR:", detail);

      return res.status(502).json({
        error: "Email gagal dikirim. Periksa konfigurasi Resend."
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Magic link berhasil dikirim."
    });

  } catch (error) {
    console.error("MAGIC LINK ERROR:", error);

    return res.status(500).json({
      error: error?.message || "Terjadi kesalahan server."
    });
  }
}
