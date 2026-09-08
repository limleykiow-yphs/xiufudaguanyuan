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
  } catch (e) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  // 只允许 GET
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      message: "Method not allowed"
    });
  }

  // --------------------------------------------------
  // 1. 验证教师后台身份
  // --------------------------------------------------

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

  // --------------------------------------------------
  // 2. Supabase 环境变量
  // --------------------------------------------------

  const supabaseUrl = String(
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
    // 3. 分开读取 players
    // ------------------------------------------------

    const playersUrl =
      `${supabaseUrl}/rest/v1/players` +
      `?select=id,created_at,role,name,external_id,class_name,department,avatar,updated_at` +
      `&order=created_at.desc`;

    const playersResponse = await fetch(playersUrl, {
      headers: {
        apikey: supabaseSecretKey,
        Authorization: `Bearer ${supabaseSecretKey}`,
        Accept: "application/json"
      }
    });

    const playersText = await playersResponse.text();

    if (!playersResponse.ok) {
      console.error(
        "Supabase players error:",
        playersText
      );

      return res.status(500).json({
        ok: false,
        message: "读取玩家资料失败"
      });
    }

    const players = playersText
      ? JSON.parse(playersText)
      : [];

    // ------------------------------------------------
    // 4. 分开读取 player_progress
    //    不再依赖 Supabase 嵌套关系查询
    // ------------------------------------------------

    const progressUrl =
      `${supabaseUrl}/rest/v1/player_progress` +
      `?select=*`;

    const progressResponse = await fetch(
      progressUrl,
      {
        headers: {
          apikey: supabaseSecretKey,
          Authorization:
            `Bearer ${supabaseSecretKey}`,
          Accept: "application/json"
        }
      }
    );

    const progressText =
      await progressResponse.text();

    if (!progressResponse.ok) {
      console.error(
        "Supabase player_progress error:",
        progressText
      );

      return res.status(500).json({
        ok: false,
        message: "读取玩家进度失败"
      });
    }

    const progressRows = progressText
      ? JSON.parse(progressText)
      : [];

    // ------------------------------------------------
    // 5. 按 player_id 建立进度索引
    // ------------------------------------------------

    const progressMap = new Map();

    for (const row of progressRows) {
      const key = String(row.player_id);

      // 如果同一个玩家以后出现多笔记录，
      // 优先保留更新时间较新的记录
      const old = progressMap.get(key);

      if (!old) {
        progressMap.set(key, row);
        continue;
      }

      const oldTime = new Date(
        old.updated_at ||
        old.created_at ||
        0
      ).getTime();

      const newTime = new Date(
        row.updated_at ||
        row.created_at ||
        0
      ).getTime();

      if (newTime >= oldTime) {
        progressMap.set(key, row);
      }
    }

    // ------------------------------------------------
    // 6. 合并玩家资料 + 云端游戏进度
    // ------------------------------------------------

    const mergedPlayers = players.map(player => {
      const progress =
        progressMap.get(String(player.id)) || null;

      return {
        id: player.id,
        created_at: player.created_at,
        updated_at:
          progress?.updated_at ||
          player.updated_at ||
          player.created_at,

        role: player.role || "",
        name: player.name || "",
        external_id: player.external_id || "",
        class_name: player.class_name || "",
        department: player.department || "",
        avatar: player.avatar || "",

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
          progress?.completed ?? [],

        stage_records:
          progress?.stage_records ?? {},

        has_cloud_progress: !!progress
      };
    });

    // ------------------------------------------------
    // 7. 返回教师后台
    // ------------------------------------------------

    return res.status(200).json({
      ok: true,
      players: mergedPlayers,
      progress_count: progressRows.length
    });

  } catch (error) {
    console.error(
      "admin-players error:",
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        "服务器读取玩家资料时发生错误"
    });
  }
};
