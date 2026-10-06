// Vercel Serverless Function: GET /api/auth-check
const { validateToken } = require('./_auth.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const session = validateToken(req.headers.authorization);
  if (!session) {
    return res.status(401).json({ success: false, error: 'ログインの有効期限が切れました。再度ログインしてください。' });
  }

  return res.status(200).json({ success: true, username: session.username });
};
