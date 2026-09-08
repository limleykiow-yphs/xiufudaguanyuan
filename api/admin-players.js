const crypto = require("crypto");

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function verifyToken(token, secret) {
  try {
    if (!token || !secret) return false;

    const parts = token.split(".");
    if (parts.length !== 2) return false;

    const payload = parts[0];
    const signature = parts[1];

    const expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");

    if (!safeEqual(signature, expected)) return false;

    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    return Number(data.exp) > Date.now();
  } catch (e) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      message: "Method not allowed"
    });
  }

  const adminPassword = process.env.TEACHER_ADMIN_PASSWORD;

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : "";

  if (!verifyToken(token, adminPassword)) {
    return res.status(401).json({
      ok: false,
      message: "教师登录已失效，请重新登录"
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    return res.status(500).json({
      ok: false,
      message: "Supabase 环境变量尚未设置"
    });
  }

  try {
    const url =
      `${supabaseUrl}/rest/v1/players` +
      `?select=id,created_at,role,name,external_id,class_name,department,avatar,updated_at,player_progress(*)` +
      `&order=created_at.desc`;

    const response = await fetch(url, {
      headers: {
        apikey: supabaseSecretKey,
        Authorization: `Bearer ${supabaseSecretKey}`
      }
    });

    const text = await response.text();

    if (!response.ok) {
      console.error("Supabase error:", text);

      return res.status(500).json({
        ok: false,
        message: "读取云端玩家资料失败"
      });
    }

    const players = JSON.parse(text);

    return res.status(200).json({
      ok: true,
      players
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      message: "服务器读取玩家资料时发生错误"
    });
  }
};
