const crypto = require("crypto");

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

async function supabaseRequest(path, options = {}) {
  const base = String(
    process.env.SUPABASE_URL || ""
  ).replace(/\/+$/, "");

  const key = process.env.SUPABASE_SECRET_KEY;

  if (!base || !key) {
    throw new Error("Supabase 环境变量尚未设置");
  }

  const response = await fetch(
    `${base}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : null;
}

// --------------------------------------------------
// 与目前学生版 index.html 使用相同的 PIN hash
// 这样现有玩家不用重新注册
// --------------------------------------------------

function hashPin(pin) {
  return crypto
    .createHash("sha256")
    .update("dream-garden-pin-v1:" + String(pin))
    .digest("hex");
}

// --------------------------------------------------
// 建立玩家登录 token
// --------------------------------------------------

function createPlayerToken(player) {
  const secret =
    process.env.PLAYER_SESSION_SECRET ||
    process.env.TEACHER_ADMIN_PASSWORD;

  if (!secret) {
    throw new Error("玩家 Session Secret 尚未设置");
  }

  const now = Date.now();

  const payload = Buffer.from(
    JSON.stringify({
      player_id: Number(player.id),
      role: String(player.role || ""),
      external_id: String(player.external_id || ""),

      // 12 小时有效
      exp: now + 12 * 60 * 60 * 1000
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

// --------------------------------------------------
// API
// --------------------------------------------------

module.exports = async function handler(req, res) {

  if (req.method !== "POST") {
    return json(res, 405, {
      ok: false,
      message: "Method not allowed"
    });
  }

  try {

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});

    const role =
      String(body.role || "").trim();

    const externalId =
      String(
        body.external_id ||
        body.externalId ||
        ""
      ).trim();

    const pin =
      String(body.pin || "").trim();

    // ------------------------------------------------
    // 基本检查
    // ------------------------------------------------

    if (
      role !== "student" &&
      role !== "staff"
    ) {
      return json(res, 400, {
        ok: false,
        message: "玩家身份不正确"
      });
    }

    if (!externalId) {
      return json(res, 400, {
        ok: false,
        message: "请输入学号／编号"
      });
    }

    if (!/^\d{4}$/.test(pin)) {
      return json(res, 400, {
        ok: false,
        message: "PIN 必须为 4 位数字"
      });
    }

    // ------------------------------------------------
    // 查找玩家
    // ------------------------------------------------

    const players =
      await supabaseRequest(
        "players" +
        "?role=eq." +
        encodeURIComponent(role) +
        "&external_id=eq." +
        encodeURIComponent(externalId) +
        "&select=id,role,name,external_id,class_name,department,avatar,pin_hash" +
        "&limit=1",
        {
          method: "GET"
        }
      );

    if (!players || !players.length) {
      return json(res, 401, {
        ok: false,
        message: "学号／编号或 PIN 不正确"
      });
    }

    const player = players[0];

    // ------------------------------------------------
    // 验证 PIN
    // ------------------------------------------------

    const incomingHash = hashPin(pin);

    const savedHash =
      String(player.pin_hash || "");

    const a = Buffer.from(incomingHash);
    const b = Buffer.from(savedHash);

    const pinCorrect =
      a.length === b.length &&
      crypto.timingSafeEqual(a, b);

    if (!pinCorrect) {
      return json(res, 401, {
        ok: false,
        message: "学号／编号或 PIN 不正确"
      });
    }

    // ------------------------------------------------
    // PIN 正确 → 发出玩家 token
    // ------------------------------------------------

    const token =
      createPlayerToken(player);

    return json(res, 200, {
      ok: true,
      token,

      player: {
        id: Number(player.id),
        role: player.role || "",
        name: player.name || "",
        external_id: player.external_id || "",
        class_name: player.class_name || "",
        department: player.department || "",
        avatar: player.avatar || ""
      }
    });

  } catch (error) {

    console.error(
      "player-login error:",
      error
    );

    return json(res, 500, {
      ok: false,
      message:
        error.message ||
        "玩家登录发生错误"
    });
  }
};
