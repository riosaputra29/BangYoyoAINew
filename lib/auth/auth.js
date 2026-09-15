import crypto from "crypto";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function base64urlJson(value) {
  return base64url(JSON.stringify(value));
}

function timingSafeEqual(a, b) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);

  if (aa.length !== bb.length) return false;

  return crypto.timingSafeEqual(aa, bb);
}

function hmac(secret, data) {
  return crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest();
}

export async function signTanyaToken(payload) {
  const secret = process.env.MAGIC_LINK_SECRET;

  if (!secret) {
    throw new Error("MAGIC_LINK_SECRET belum diset.");
  }

  const header = {
    alg: "HS256",
    typ: "JWT"
  };

  const encodedHeader = base64urlJson(header);
  const encodedPayload = base64urlJson(payload);

  const data = `${encodedHeader}.${encodedPayload}`;

  const signature = base64url(
    hmac(secret, data)
  );

  return `${data}.${signature}`;
}

export async function verifyTanyaToken(token) {
  const secret = process.env.MAGIC_LINK_SECRET;

  if (!secret) {
    throw new Error("MAGIC_LINK_SECRET belum diset.");
  }

  if (!token || typeof token !== "string") {
    throw new Error("Token tidak valid.");
  }

  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new Error("Token tidak valid.");
  }

  const [header, payload, signature] = parts;

  const expectedSignature = base64url(
    hmac(secret, `${header}.${payload}`)
  );

  if (!timingSafeEqual(signature, expectedSignature)) {
    throw new Error("Signature token tidak valid.");
  }

  let data;

  try {
    data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
  } catch {
    throw new Error("Payload token tidak valid.");
  }

  if (!data.exp) {
    throw new Error("Token tidak memiliki expiry.");
  }

  if (Date.now() >= Number(data.exp) * 1000) {
    throw new Error("Token sudah kedaluwarsa.");
  }

  return data;
}

export function getBearerToken(req) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  return auth.slice(7).trim() || null;
}

export async function verifyMagicSessionFromRequest(req) {
  const token = getBearerToken(req);

  if (!token) {
    throw new Error("Unauthorized");
  }

  const data = await verifyTanyaToken(token);

  if (data.type !== "session") {
    throw new Error("Unauthorized");
  }

  return data;
}
