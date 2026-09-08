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


// --------------------------------------------------
// Supabase Server Request
// --------------------------------------------------

async function supabaseRequest(path, options = {}) {
  const base = String(
    process.env.SUPABASE_URL || ""
  ).replace(/\/+$/, "");

  const key =
    process.env.SUPABASE_SECRET_KEY;

  if (!base || !key) {
    throw new Error(
      "Supabase 环境变量尚未设置"
    );
  }

  const response = await fetch(
    `${base}/rest/v1/${path}`,
    {
      ...options,

      headers: {
        apikey: key,

        Authorization:
          `Bearer ${key}`,

        "Content-Type":
          "application/json",

        Prefer:
          options.prefer ||
          "return=representation",

        ...(options.headers || {})
      }
    }
  );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }

  return text
    ? JSON.parse(text)
    : null;
}


// --------------------------------------------------
// 安全比较
// --------------------------------------------------

function safeEqual(a, b) {
  const aa =
    Buffer.from(String(a || ""));

  const bb =
    Buffer.from(String(b || ""));

  if (aa.length !== bb.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    aa,
    bb
  );
}


// --------------------------------------------------
// 验证玩家 Token
// --------------------------------------------------

function verifyPlayerToken(token) {
  const secret =
    process.env.PLAYER_SESSION_SECRET ||
    process.env.TEACHER_ADMIN_PASSWORD;

  if (!secret) {
    throw new Error(
      "玩家 Session Secret 尚未设置"
    );
  }

  if (
    !token ||
    typeof token !== "string"
  ) {
    return null;
  }

  const parts =
    token.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const payloadPart =
    parts[0];

  const signaturePart =
    parts[1];

  const expectedSignature =
    crypto
      .createHmac(
        "sha256",
        secret
      )
      .update(payloadPart)
      .digest("base64url");

  if (
    !safeEqual(
      signaturePart,
      expectedSignature
    )
  ) {
    return null;
  }

  let payload;

  try {
    payload =
      JSON.parse(
        Buffer
          .from(
            payloadPart,
            "base64url"
          )
          .toString("utf8")
      );
  } catch {
    return null;
  }

  if (!payload.player_id) {
    return null;
  }

  if (
    !payload.exp ||
    Date.now() > Number(payload.exp)
  ) {
    return null;
  }

  return payload;
}


// --------------------------------------------------
// 把数值限制为非负整数
// --------------------------------------------------

function safeNumber(value) {
  const n = Number(value);

  if (
    !Number.isFinite(n) ||
    n < 0
  ) {
    return 0;
  }

  return Math.floor(n);
}


// --------------------------------------------------
// API
// --------------------------------------------------

module.exports =
async function handler(req, res) {

  if (req.method !== "POST") {
    return json(
      res,
      405,
      {
        ok: false,
        message:
          "Method not allowed"
      }
    );
  }

  try {

    // ----------------------------------------------
    // 读取 Authorization Token
    // ----------------------------------------------

    const authHeader =
      String(
        req.headers.authorization ||
        ""
      );

    const match =
      authHeader.match(
        /^Bearer\s+(.+)$/i
      );

    const token =
      match
        ? match[1].trim()
        : "";

    const session =
      verifyPlayerToken(token);

    if (!session) {
      return json(
        res,
        401,
        {
          ok: false,
          message:
            "玩家登录已失效，请重新登录"
        }
      );
    }


    // ----------------------------------------------
    // 玩家身份只从 Token 获取
    // ----------------------------------------------

    const playerId =
      Number(session.player_id);


    // ----------------------------------------------
    // 读取浏览器传来的游戏进度
    // ----------------------------------------------

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});


    // ----------------------------------------------
    // 注意：
    // 即使浏览器偷偷传 player_id，
    // 这里也完全不使用它。
    // ----------------------------------------------

    const progress = {

      player_id:
        playerId,

      score:
        safeNumber(body.score),

      coins:
        safeNumber(body.coins),

      correct:
        safeNumber(body.correct),

      wrong:
        safeNumber(body.wrong),

      answered:
        safeNumber(body.answered),

      combo:
        safeNumber(body.combo),

      best_combo:
        safeNumber(
          body.best_combo ??
          body.bestCombo
        ),

      completed:
        body.completed &&
        typeof body.completed === "object" &&
        !Array.isArray(body.completed)
          ? body.completed
          : {},

      stage_records:
        body.stage_records &&
        typeof body.stage_records === "object" &&
        !Array.isArray(body.stage_records)

          ? body.stage_records

          : (
              body.stageRecords &&
              typeof body.stageRecords === "object" &&
              !Array.isArray(body.stageRecords)

                ? body.stageRecords
                : {}
            ),

      updated_at:
        new Date().toISOString()
    };


    // ----------------------------------------------
    // 确认玩家确实存在
    // ----------------------------------------------

    const players =
      await supabaseRequest(
        `players?id=eq.${playerId}` +
        "&select=id" +
        "&limit=1",
        {
          method: "GET"
        }
      );

    if (
      !players ||
      !players.length
    ) {
      return json(
        res,
        404,
        {
          ok: false,
          message:
            "找不到玩家资料"
        }
      );
    }


    // ----------------------------------------------
    // 查找现有进度
    // ----------------------------------------------

    const existing =
      await supabaseRequest(
        `player_progress?player_id=eq.${playerId}` +
        "&select=id" +
        "&limit=1",
        {
          method: "GET"
        }
      );


    let result;


    // ----------------------------------------------
    // 有记录 → 更新
    // ----------------------------------------------

    if (
      existing &&
      existing.length
    ) {

      result =
        await supabaseRequest(
          `player_progress?player_id=eq.${playerId}`,
          {
            method: "PATCH",

            body:
              JSON.stringify(progress),

            prefer:
              "return=representation"
          }
        );

    }

    // ----------------------------------------------
    // 没有记录 → 新增
    // ----------------------------------------------

    else {

      result =
        await supabaseRequest(
          "player_progress",
          {
            method: "POST",

            body:
              JSON.stringify(progress),

            prefer:
              "return=representation"
          }
        );
    }


    return json(
      res,
      200,
      {
        ok: true,

        message:
          "游戏进度已安全保存到云端",

        player_id:
          playerId,

        progress:
          result
      }
    );


  } catch (error) {

    console.error(
      "save-progress-secure error:",
      error
    );

    return json(
      res,
      500,
      {
        ok: false,

        message:
          error.message ||
          "保存游戏进度失败"
      }
    );
  }
};
