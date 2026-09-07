const crypto = require("crypto");

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      message: "Method not allowed"
    });
  }

  const { password } = req.body || {};
  const adminPassword = process.env.TEACHER_ADMIN_PASSWORD;

  if (!adminPassword) {
    return res.status(500).json({
      ok: false,
      message: "教师后台密码尚未设置"
    });
  }

  if (!safeEqual(password, adminPassword)) {
    return res.status(401).json({
      ok: false,
      message: "教师管理密码错误"
    });
  }

  return res.status(200).json({
    ok: true,
    message: "验证成功"
  });
};
