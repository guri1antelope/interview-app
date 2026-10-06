// Vercel Serverless Function / ローカル共通 認証モジュール (api/_auth.js)
const crypto = require('crypto');

const SECRET_KEY = process.env.TOKEN_SECRET || process.env.GEMINI_API_KEY || 'koshi-interview-secret-key-2026';

function base64url(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function unbase64url(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function getRegisteredUsers() {
  const defaultUsers = 'yumi:6AG6H7ZiChqB,mai:HNx5h6EXcqTw,aki:CUhasAa9JM3U,佑実:6AG6H7ZiChqB,真衣:HNx5h6EXcqTw';
  const envUsers = process.env.AUTH_USERS || defaultUsers;
  const users = {};
  envUsers.split(',').forEach(pair => {
    const trimmed = pair.trim();
    const idx = trimmed.indexOf(':');
    if (idx !== -1) {
      const u = trimmed.slice(0, idx).trim();
      const p = trimmed.slice(idx + 1).trim();
      if (u && p) {
        users[u] = p;
      }
    }
  });
  return users;
}

function verifyCredentials(username, password) {
  if (!username || !password) return false;
  const users = getRegisteredUsers();
  return users[username] === password;
}

function generateToken(username) {
  const payload = {
    u: username,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30日間有効
  };
  const pStr = base64url(Buffer.from(JSON.stringify(payload)));
  const sig = base64url(crypto.createHmac('sha256', SECRET_KEY).update(pStr).digest());
  return `${pStr}.${sig}`;
}

function validateToken(authHeader) {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [pStr, sig] = parts;
  const expectedSig = base64url(crypto.createHmac('sha256', SECRET_KEY).update(pStr).digest());
  if (sig !== expectedSig) return null;

  try {
    const payload = JSON.parse(unbase64url(pStr).toString('utf-8'));
    if (Date.now() > payload.exp) return null;
    return { username: payload.u, expiresAt: payload.exp };
  } catch (e) {
    return null;
  }
}

module.exports = {
  verifyCredentials,
  generateToken,
  validateToken
};
