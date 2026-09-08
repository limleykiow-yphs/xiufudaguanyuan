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

    if (!safeEqual(signature, expected)) {
      return false;
    }

    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    return Number(data.exp) > Date.now();

  } catch (error) {
    return false;
  }
}

// 读取 Supabase
async function supabaseGet(baseUrl, secretKey, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");

  const response = await fetch(
    `${base}/rest/v1/${path}`,
    {
      method: "GET",
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      }
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : [];
}

module.exports = async function handler(req, res) {

  // ------------------------------------------------
  // 只允许 GET
  // ------------------------------------------------

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      message: "Method not allowed"
    });
  }

  // ------------------------------------------------
  // 教师后台身份验证
  // ------------------------------------------------

  const adminPassword =
    process.env.TEACHER_ADMIN_PASSWORD;

  const auth =
    req.headers.authorization || "";

  const token =
    auth.startsWith("Bearer ")
      ? auth.slice(7)
      : "";

  if (!verifyToken(token, adminPassword)) {
    return res.status(401).json({
      ok: false,
      message: "教师登录已失效，请重新登录"
    });
  }

  // ------------------------------------------------
  // Supabase 环境变量
  // ------------------------------------------------

  const supabaseUrl =
    String(
      process.env.SUPABASE_URL || ""
    ).replace(/\/+$/, "");

  const supabaseSecretKey =
    process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    return res.status(500).json({
      ok: false,
      message: "Supabase 环境变量尚未设置"
    });
  }

  try {

    // ------------------------------------------------
    // 1. 读取所有玩家基本资料
    // ------------------------------------------------

    const players =
      await supabaseGet(
        supabaseUrl,
        supabaseSecretKey,
        "players?select=id,created_at,role,name,external_id,class_name,department,avatar,updated_at&order=created_at.desc"
      );

    // ------------------------------------------------
    // 2. 读取所有玩家游戏进度
    // ------------------------------------------------

    const progressRows =
      await supabaseGet(
        supabaseUrl,
        supabaseSecretKey,
        "player_progress?select=*"
      );

    // ------------------------------------------------
    // 3. 以 player_id 建立索引
    // ------------------------------------------------

    const progressMap = new Map();

    for (const row of progressRows) {

      const key =
        String(row.player_id);

      const existing =
        progressMap.get(key);

      // 第一次出现，直接存入
      if (!existing) {
        progressMap.set(key, row);
        continue;
      }

      // 如果以后同一玩家出现多笔资料，
      // 保留更新时间较新的那一笔
      const oldTime =
        new Date(
          existing.updated_at ||
          existing.created_at ||
          0
        ).getTime();

      const newTime =
        new Date(
          row.updated_at ||
          row.created_at ||
          0
        ).getTime();

      if (newTime >= oldTime) {
        progressMap.set(key, row);
      }
    }

    // ------------------------------------------------
    // 4. 合并玩家资料与进度
    // ------------------------------------------------

    const mergedPlayers =
      players.map(player => {

        const progress =
          progressMap.get(
            String(player.id)
          ) || null;

        const safeProgress =
          progress || {
            score: 0,
            coins: 0,
            correct: 0,
            wrong: 0,
            answered: 0,
            combo: 0,
            best_combo: 0,
            completed: {},
            stage_records: {},
            updated_at: null
          };

        return {

          // 玩家基本资料
          id: player.id,
          created_at:
            player.created_at,

          role:
            player.role || "",

          name:
            player.name || "",

          external_id:
            player.external_id || "",

          class_name:
            player.class_name || "",

          department:
            player.department || "",

          avatar:
            player.avatar || "",

          // ========================================
          // 关键：
          // teacher.html 目前读取 x._progress
          // ========================================

          _progress: safeProgress,

          // 同时保留直接字段，方便以后使用
          score:
            Number(
              safeProgress.score || 0
            ),

          coins:
            Number(
              safeProgress.coins || 0
            ),

          correct:
            Number(
              safeProgress.correct || 0
            ),

          wrong:
            Number(
              safeProgress.wrong || 0
            ),

          answered:
            Number(
              safeProgress.answered || 0
            ),

          combo:
            Number(
              safeProgress.combo || 0
            ),

          best_combo:
            Number(
              safeProgress.best_combo || 0
            ),

          completed:
            safeProgress.completed &&
            typeof safeProgress.completed === "object"
              ? safeProgress.completed
              : {},

          stage_records:
            safeProgress.stage_records &&
            typeof safeProgress.stage_records === "object"
              ? safeProgress.stage_records
              : {},

          // 用云端进度更新时间优先
          updated_at:
            safeProgress.updated_at ||
            player.updated_at ||
            player.created_at,

          has_cloud_progress:
            !!progress
        };
      });

    // ------------------------------------------------
    // 5. 返回教师后台
    // ------------------------------------------------

    return res.status(200).json({
      ok: true,
      players: mergedPlayers,
      player_count:
        mergedPlayers.length,
      progress_count:
        progressRows.length
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
