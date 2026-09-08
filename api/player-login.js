const crypto = require("crypto");

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

async function supabaseRequest(path, options = {}) {
  const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!base || !key) {
    throw new Error("Supabase 环境变量尚未设置");
  }

  const response = await fetch(`${base}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

function hashPin(pin) {
  return crypto
    .createHash("sha256")
    .update("dream-garden-pin-v1:" + String(pin))
    .digest("hex");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));

  if (aa.length !== bb.length) return false;

  return crypto.timingSafeEqual(aa, bb);
}

function createPlayerToken(player) {
  const secret =
    process.env.PLAYER_SESSION_SECRET ||
    process.env.TEACHER_ADMIN_PASSWORD;

  if (!secret) {
    throw new Error("玩家 Session Secret 尚未设置");
  }

  const payload = Buffer.from(
    JSON.stringify({
      type: "player",
      player_id: Number(player.id),
      role: String(player.role || ""),
      external_id: String(player.external_id || ""),
      exp: Date.now() + 12 * 60 * 60 * 1000
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function cleanText(value, maxLen = 60) {
  return String(value || "")
    .trim()
    .slice(0, maxLen);
}

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

    const role = cleanText(body.role, 20);
    const name = cleanText(body.name, 40);

    const externalId = cleanText(
      body.external_id || body.externalId,
      40
    );

    const className = cleanText(
      body.class_name || body.className,
      40
    );

    const department = cleanText(
      body.department,
      60
    );

    const avatar = cleanText(
      body.avatar,
      30
    );

    const pin = String(
      body.pin || ""
    ).trim();

    // =========================
    // 基本资料检查
    // =========================

    if (
      role !== "student" &&
      role !== "staff"
    ) {
      return json(res, 400, {
        ok: false,
        message: "玩家身份不正确"
      });
    }

    if (!name) {
      return json(res, 400, {
        ok: false,
        message: "请输入真实姓名"
      });
    }

    if (!externalId) {
      return json(res, 400, {
        ok: false,
        message: "请输入学号／编号"
      });
    }

    if (
      role === "student" &&
      !className
    ) {
      return json(res, 400, {
        ok: false,
        message: "请输入班级"
      });
    }

    if (
      role === "staff" &&
      !department
    ) {
      return json(res, 400, {
        ok: false,
        message: "请输入部门／职务"
      });
    }

    if (!/^\d{4}$/.test(pin)) {
      return json(res, 400, {
        ok: false,
        message: "PIN 必须为 4 位数字"
      });
    }

    // =========================
    // 查找现有玩家
    // =========================

    const rows = await supabaseRequest(
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

    const pinHash = hashPin(pin);

    let player;
    let created = false;

    // =========================
    // 已有账号：验证 PIN
    // =========================

    if (rows && rows.length) {
      const existing = rows[0];

      if (
        !safeEqual(
          existing.pin_hash,
          pinHash
        )
      ) {
        return json(res, 401, {
          ok: false,
          code: "PIN_INCORRECT",
          message:
            "这个编号已经登记，但 PIN 不正确"
        });
      }

      // PIN 正确后更新玩家基本资料
      const patch = {
        name: name,

        class_name:
          role === "student"
            ? className
            : null,

        department:
          role === "staff"
            ? department
            : null,

        avatar: avatar,

        updated_at:
          new Date().toISOString()
      };

      const updated =
        await supabaseRequest(
          `players?id=eq.${Number(
            existing.id
          )}`,
          {
            method: "PATCH",
            body:
              JSON.stringify(patch),
            prefer:
              "return=representation"
          }
        );

      player =
        updated &&
        updated.length
          ? updated[0]
          : {
              ...existing,
              ...patch
            };
    }

    // =========================
    // 新玩家：建立账号
    // =========================

    else {
      const payload = {
        role: role,
        name: name,

        external_id:
          externalId,

        class_name:
          role === "student"
            ? className
            : null,

        department:
          role === "staff"
            ? department
            : null,

        avatar: avatar,

        pin_hash:
          pinHash,

        updated_at:
          new Date().toISOString()
      };

      const made =
        await supabaseRequest(
          "players",
          {
            method: "POST",
            body:
              JSON.stringify(
                payload
              ),
            prefer:
              "return=representation"
          }
        );

      if (
        !made ||
        !made.length
      ) {
        throw new Error(
          "建立玩家资料失败"
        );
      }

      player = made[0];
      created = true;
    }

    // =========================
    // 签发安全玩家 Token
    // =========================

    const token =
      createPlayerToken(
        player
      );

    // =========================
    // 返回前端
    // PIN / pin_hash 不返回
    // =========================

    return json(res, 200, {
      ok: true,

      created:
        created,

      token:
        token,

      player: {
        id:
          Number(player.id),

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
          player.avatar || ""
      }
    });
  }

  catch (error) {
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
