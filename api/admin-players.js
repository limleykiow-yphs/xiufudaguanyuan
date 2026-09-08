const crypto = require("crypto");

// 安全比较字符串
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));

  if (x.length !== y.length) return false;

  return crypto.timingSafeEqual(x, y);
}

// 验证教师后台登录 token
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
  } catch (error) {
    return false;
  }
}

// Supabase GET 请求
async function supabaseGet(baseUrl, secretKey, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");

  const response = await fetch(`${base}/rest/v1/${path}`, {
    method: "GET",
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : [];
}

module.exports = async function handler(req, res) {
  // 只允许 GET
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      message: "Method not allowed"
    });
  }

  // 教师管理中心密码
  const adminPassword = process.env.TEACHER_ADMIN_PASSWORD;

  // 检查教师登录 token
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

  // Supabase 环境变量
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey =
    process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    return res.status(500).json({
      ok: false,
      message: "Supabase 环境变量尚未设置"
    });
  }

  try {
    // ① 读取所有玩家基本资料
    const players = await supabaseGet(
      supabaseUrl,
      supabaseSecretKey,
      "players?select=id,created_at,role,name,external_id,class_name,department,avatar,updated_at&order=created_at.desc"
    );

    // ② 独立读取所有玩家游戏进度
    const progresses = await supabaseGet(
      supabaseUrl,
      supabaseSecretKey,
      "player_progress?select=*"
    );

    // ③ 按 player_id 建立进度索引
    const progressMap = new Map();

    for (const progress of progresses) {
      progressMap.set(
        String(progress.player_id),
        progress
      );
    }

    // ④ 把 players 与 player_progress 合并
    const mergedPlayers = players.map(player => {
      const progress =
        progressMap.get(String(player.id)) || null;

      return {
        ...player,

        // 保留教师后台原来可能使用的格式
        player_progress: progress
          ? [progress]
          : [],

        // 另外提供一个直接 progress 对象
        progress: progress,

        // 同时把主要统计放到顶层
        score: Number(progress?.score || 0),
        coins: Number(progress?.coins || 0),
        correct: Number(progress?.correct || 0),
        wrong: Number(progress?.wrong || 0),
        answered: Number(progress?.answered || 0),
        combo: Number(progress?.combo || 0),
        best_combo: Number(
          progress?.best_combo || 0
        ),

        completed:
          progress?.completed &&
          typeof progress.completed === "object"
            ? progress.completed
            : {},

        stage_records:
          progress?.stage_records &&
          typeof progress.stage_records === "object"
            ? progress.stage_records
            : {},

        progress_updated_at:
          progress?.updated_at || null
      };
    });

    // ⑤ 返回教师后台
    return res.status(200).json({
      ok: true,
      players: mergedPlayers,
      playerCount: mergedPlayers.length,
      progressCount: progresses.length
    });

  } catch (error) {
    console.error(
      "admin-players error:",
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        "读取云端玩家资料时发生错误"
    });
  }
};
