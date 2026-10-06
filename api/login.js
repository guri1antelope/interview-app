// Vercel Serverless Function: POST /api/login
const { verifyCredentials, generateToken } = require('./_auth.js');

module.exports = async function handler(req, res) {
  // CORSヘッダー設定
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  } else if (!body) {
    body = {};
  }

  const username = (body.username || '').trim();
  const password = (body.password || '').trim();

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'ユーザー名とパスワードを入力してください。' });
  }

  if (!verifyCredentials(username, password)) {
    return res.status(401).json({ success: false, error: 'ユーザー名またはパスワードが正しくありません。' });
  }

  const token = generateToken(username);
  return res.status(200).json({
    success: true,
    token,
    username
  });
};
