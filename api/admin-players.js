const crypto = require("crypto");

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      message: "Method not allowed"
    });
  }

  const password = req.body?.password || "";
  const adminPassword = process.env.TEACHER_ADMIN_PASSWORD;

  if (!adminPassword) {
    return res.status(500).json({
      ok: false,
      message: "教师管理密码尚未设置"
    });
  }

  if (!safeEqual(password, adminPassword)) {
    return res.status(401).json({
      ok: false,
      message: "教师管理密码错误"
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
