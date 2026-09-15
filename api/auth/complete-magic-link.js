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

  const received = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
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

function createSessionToken(user) {
  const secret = process.env.MAGIC_LINK_SECRET;

  if (!secret) {
    throw new Error("MAGIC_LINK_SECRET belum diset.");
  }

  const now = Math.floor(Date.now() / 1000);

  const payload = {
    type: "session",
    userId: user.userId,
    sub: user.sub,
    email: user.email,
    name: user.name,
    picture: user.picture,
    auth_provider: "magic_link",
    iat: now,
    exp: now + 7 * 24 * 60 * 60
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
    const magicToken = String(req.body?.token || "").trim();

    if (!magicToken) {
      return res.status(400).json({
        error: "Token Magic Link kosong."
      });
    }

    const magic = verifyMagicToken(magicToken);

    const user = {
      userId: magic.userId,
      sub: magic.userId,
      email: magic.email,
      name: magic.email.split("@")[0],
      picture: "",
      auth_provider: "magic_link"
    };

    const session = createSessionToken(user);

    return res.status(200).json({
      ok: true,
      token: session,
      user
    });

  } catch (error) {
    console.error("COMPLETE MAGIC LINK ERROR:", error);

    return res.status(401).json({
      error:
        error?.message ||
        "Magic link tidak valid atau sudah kedaluwarsa."
    });
  }
}
