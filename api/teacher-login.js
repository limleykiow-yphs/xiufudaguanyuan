const crypto = require("crypto");

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function createToken(secret) {
  const payloadObject = {
    exp: Date.now() + 8 * 60 * 60 * 1000
  };

  const payload = Buffer
    .from(JSON.stringify(payloadObject))
    .toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
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
      message: "教师管理密码尚未设置"
    });
  }

  if (!safeEqual(password, adminPassword)) {
    return res.status(401).json({
      ok: false,
      message: "教师管理密码错误"
    });
  }

  const token = createToken(adminPassword);

  return res.status(200).json({
    ok: true,
    token,
    message: "登录成功"
  });
};
