import {
  signTanyaToken,
  verifyTanyaToken
} from "../../lib/auth.js";

export const runtime = "nodejs";

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {

    const magicToken = String(
      req.body?.token || ""
    ).trim();

    if (!magicToken) {
      return res.status(400).json({
        error: "Token Magic Link kosong."
      });
    }

    const magic = await verifyTanyaToken(magicToken);

    if (
      magic.type !== "magic" ||
      !magic.email ||
      !magic.userId
    ) {
      throw new Error("Invalid magic token");
    }

    const now = Math.floor(Date.now() / 1000);

    const user = {

      userId: magic.userId,

      sub: magic.userId,

      email: magic.email,

      name: magic.email.split("@")[0],

      picture: "",

      auth_provider: "magic_link"
    };

    const session = await signTanyaToken({

      type: "session",

      userId: user.userId,

      sub: user.sub,

      email: user.email,

      name: user.name,

      picture: user.picture,

      auth_provider: "magic_link",

      iat: now,

      exp: now + 7 * 24 * 60 * 60
    });

    return res.status(200).json({

      ok: true,

      token: session,

      user

    });

  } catch (error) {

    console.error(
      "COMPLETE MAGIC LINK ERROR:",
      error
    );

    return res.status(401).json({
      error:
        error?.message ||
        "Magic link tidak valid atau sudah kedaluwarsa."
    });
  }
}
