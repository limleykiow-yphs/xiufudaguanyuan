const crypto = require("crypto");

function json(res, status, data) {
  res.statusCode = status;

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  res.end(
    JSON.stringify(data)
  );
}


// --------------------------------------------------
// Supabase Server Request
// --------------------------------------------------

async function supabaseRequest(
  path,
  options = {}
) {

  const base =
    String(
      process.env.SUPABASE_URL || ""
    ).replace(/\/+$/, "");

  const key =
    process.env.SUPABASE_SECRET_KEY;


  if (!base || !key) {

    throw new Error(
      "Supabase 环境变量尚未设置"
    );
  }


  const response =
    await fetch(
      `${base}/rest/v1/${path}`,
      {
        ...options,

        headers: {
          apikey: key,

          Authorization:
            `Bearer ${key}`,

          "Content-Type":
            "application/json",

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
// 安全比较签名
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
// API
// --------------------------------------------------

module.exports =
async function handler(
  req,
  res
) {

  if (req.method !== "GET") {

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
    // 从 Authorization 读取 Token
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
    // 玩家 ID 只从 Token 获取
    // 不接受浏览器传 player_id
    // ----------------------------------------------

    const playerId =
      Number(
        session.player_id
      );


    // ----------------------------------------------
    // 读取玩家资料
    // ----------------------------------------------

    const players =
      await supabaseRequest(
        `players?id=eq.${playerId}` +
        "&select=" +
        "id,role,name,external_id,class_name,department,avatar" +
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


    const player =
      players[0];


    // ----------------------------------------------
    // 读取该玩家的进度
    // ----------------------------------------------

    const rows =
      await supabaseRequest(
        `player_progress?player_id=eq.${playerId}` +
        "&select=" +
        "score,coins,correct,wrong,answered,combo,best_combo,completed,stage_records,updated_at" +
        "&limit=1",
        {
          method: "GET"
        }
      );


    // ----------------------------------------------
    // 如果是新玩家，还没有进度记录
    // 返回全 0，不报错
    // ----------------------------------------------

    const progress =
      rows && rows.length
        ? rows[0]
        : {
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


    return json(
      res,
      200,
      {
        ok: true,

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
        },

        progress
      }
    );


  } catch (error) {

    console.error(
      "load-progress error:",
      error
    );


    return json(
      res,
      500,
      {
        ok: false,

        message:
          error.message ||
          "读取游戏进度失败"
      }
    );
  }
};
