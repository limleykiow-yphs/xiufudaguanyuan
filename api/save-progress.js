const crypto = require("crypto");

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

async function supabaseRequest(path, options = {}) {
  const base = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    const externalId = String(
      body.external_id || body.externalId || body.studentId || body.staffId || ""
    ).trim();

    if (!externalId) {
      return json(res, 400, {
        ok: false,
        error: "缺少学号／教职员编号"
      });
    }

    // 先找玩家
    const players = await supabaseRequest(
      `players?external_id=eq.${encodeURIComponent(externalId)}&select=id,external_id&limit=1`,
      { method: "GET" }
    );

    if (!players || !players.length) {
      return json(res, 404, {
        ok: false,
        error: "找不到玩家资料"
      });
    }

    const playerId = players[0].id;

    const completed = Array.isArray(body.completed)
      ? body.completed
      : Array.isArray(body.completed_stages)
      ? body.completed_stages
      : [];

    const progress = {
      player_id: playerId,
      score: Number(body.score || 0),
      coins: Number(body.coins || 0),
      correct: Number(body.correct || 0),
      wrong: Number(body.wrong || 0),
      answered: Number(body.answered || 0),
      combo: Number(body.combo || 0),
      best_combo: Number(body.best_combo || body.bestCombo || 0),
      completed: completed,
      stage_records:
        body.stage_records ||
        body.stageRecords ||
        {},
      updated_at: new Date().toISOString()
    };

    // 查是否已有进度
    const existing = await supabaseRequest(
      `player_progress?player_id=eq.${encodeURIComponent(playerId)}&select=player_id&limit=1`,
      { method: "GET" }
    );

    let result;

    if (existing && existing.length) {
      result = await supabaseRequest(
        `player_progress?player_id=eq.${encodeURIComponent(playerId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(progress),
          prefer: "return=representation"
        }
      );
    } else {
      result = await supabaseRequest("player_progress", {
        method: "POST",
        body: JSON.stringify(progress),
        prefer: "return=representation"
      });
    }

    return json(res, 200, {
      ok: true,
      message: "游戏进度已保存到云端",
      player_id: playerId,
      progress: result
    });
  } catch (error) {
    console.error("save-progress error:", error);

    return json(res, 500, {
      ok: false,
      error: error.message || "保存失败"
    });
  }
};
