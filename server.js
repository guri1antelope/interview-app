// 高志中等 面接トレーニング ローカルAI音声サーバー (server.js)
// 外部npmパッケージ不要・Node.js標準機能のみで動作

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = 8000;
const ROOT_DIR = __dirname;
const CACHE_DIR = path.join(ROOT_DIR, 'audio_cache');
const VOICE = 'ja-JP-KeitaNeural'; // 落ち着いた大人の男性声

// .env から環境変数を読み込み
function loadEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
  }
}
loadEnv();

// キャッシュディレクトリの作成
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Edge-TTS 音声生成（WebSocket経由）
function generateVoice(text) {
  return new Promise((resolve, reject) => {
    const wsUrl = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EA6542DED6D315261D387042";
    
    let ws;
    try {
      ws = new WebSocket(wsUrl, {
        headers: {
          "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
        }
      });
    } catch (e) {
      return reject(e);
    }

    const audioChunks = [];
    const requestId = crypto.randomUUID().replace(/-/g, "");
    let isResolved = false;

    // タイムアウト設定 (15秒)
    const timer = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        try { ws.close(); } catch(e) {}
        reject(new Error("TTS request timed out"));
      }
    }, 15000);

    ws.onopen = () => {
      // 1. 設定メッセージ送信
      const configMsg = "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                outputFormat: "audio-24khz-48kbitrate-mono-mp3"
              }
            }
          }
        });
      ws.send(configMsg);

      // 2. SSMLメッセージ送信
      const dateStr = new Date().toString();
      const escapedText = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ja-JP'><voice name='${VOICE}'><prosody pitch='+0Hz' rate='-5%'>${escapedText}</prosody></voice></speak>`;
      const ssmlMsg = `X-Timestamp:${dateStr}\r\nX-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
      ws.send(ssmlMsg);
    };

    ws.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        if (event.data.includes("Path:turn.end")) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timer);
            try { ws.close(); } catch(e) {}
            resolve(Buffer.concat(audioChunks));
          }
        }
      } else {
        // バイナリ音声データ
        let buffer;
        if (Buffer.isBuffer(event.data)) {
          buffer = event.data;
        } else if (event.data instanceof ArrayBuffer) {
          buffer = Buffer.from(event.data);
        } else if (event.data && typeof event.data.arrayBuffer === 'function') {
          buffer = Buffer.from(await event.data.arrayBuffer());
        }

        if (buffer && buffer.length > 2) {
          const headerLen = buffer.readUInt16BE(0);
          if (buffer.length >= 2 + headerLen) {
            const headerText = buffer.subarray(2, 2 + headerLen).toString('utf-8');
            if (headerText.includes("Path:audio")) {
              audioChunks.push(buffer.subarray(2 + headerLen));
            }
          }
        }
      }
    };

    ws.onerror = (err) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timer);
        reject(err);
      }
    };

    ws.onclose = () => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timer);
        if (audioChunks.length > 0) {
          resolve(Buffer.concat(audioChunks));
        } else {
          reject(new Error("Connection closed before audio received"));
        }
      }
    };
  });
}

// Gemini API を呼び出して音声を直接評価
function evaluateAudioWithGemini(audioBase64, mimeType, questionData, userText) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return reject(new Error('GEMINI_API_KEY is not configured in .env'));
    }

    const cleanMimeType = (mimeType || 'audio/webm').split(';')[0];
    const qText = questionData ? (questionData.question || '') : '';
    const intent = questionData ? (questionData.intent || '') : '';
    const keywords = questionData && questionData.keywords ? questionData.keywords.join(', ') : '';

    const promptText = `あなたは新潟市立高志中等教育学校の入学者選抜（面接）の指導員・面接官です。
以下の質問に対する受験者（小学6年生）の回答音声を聞いて、回答内容と話し方を直接評価してください。
小学生が自信を深められるよう温かいトーンで、かつ本番で役立つ具体的なアドバイスを作成してください。

【設問ID】: ${questionData?.id || ''}
【設問カテゴリー】: ${questionData?.category || ''}
【面接官の質問】: ${qText}
【出題意図】: ${intent}
【重視キーワード】: ${keywords}
${userText ? `【補足・入力テキスト】: ${userText}` : ''}

以下の要件に従い、必ず指定のJSON形式のみで出力してください:
※練習のテンポを落とさず即座に次へ進めるよう、長文は書かず各項目とも短く的確にまとめてください（面接終了後に詳しい総合レポートを作成します）。
1. transcript: 音声から聞き取った正確な発話内容（文字起こし）。もし音声が無音や聞き取れない場合は補足テキストを基にするかその旨を記載。
2. isConclusionFirst: 冒頭で結論（「〜だからです」「理由は〜です」等）を言えているか (boolean: true または false)。
3. volumeEvaluation: 発話量の適切さ ("短め", "ちょうど良い", "長め" のいずれか)。
4. goodPoint: 良かった点（小学6年生向けに温かく、1〜2行・40〜60文字程度で簡潔に）。
5. advice: もっと良くなるアドバイス（一番直してほしいポイントを1点、1〜2行・50〜70文字程度で）。
6. mannerFeedback: 話し方のポイント（声の抑揚・速さ・ハキハキ度などを、1行・30文字以内で端的に）。
7. matchedKeywords: 発話内容に含まれていた重要キーワードの配列。

JSONフォーマット:
{
  "transcript": "...",
  "isConclusionFirst": true,
  "volumeEvaluation": "ちょうど良い",
  "goodPoint": "...",
  "advice": "...",
  "mannerFeedback": "...",
  "matchedKeywords": ["..."]
}`;

    const parts = [];
    if (audioBase64) {
      parts.push({
        inlineData: {
          mimeType: cleanMimeType,
          data: audioBase64
        }
      });
    }
    parts.push({ text: promptText });

    const payload = JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: "application/json"
      }
    });

    const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const req = https.request(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 30000
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini API HTTP ${res.statusCode}: ${data}`));
        }
        try {
          const resJson = JSON.parse(data);
          const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!rawText) {
            return reject(new Error('No content returned from Gemini API'));
          }
          const parsedEvaluation = JSON.parse(rawText);
          resolve(parsedEvaluation);
        } catch(e) {
          reject(new Error(`Failed to parse Gemini response: ${e.message}\nRaw: ${data}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Gemini API request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

// Gemini API による面接全体の詳細振り返りレポート生成
function generateOverallFeedbackWithGemini(sessionAnswers) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return reject(new Error('GEMINI_API_KEY is not configured'));

    const interviewSummary = sessionAnswers.map((item, idx) => {
      const q = item.question || {};
      return `【第 ${idx + 1} 問】
・カテゴリー: ${q.category || ''}
・質問: ${q.question || ''}
・出題意図: ${q.intent || ''}
・受検者の回答: ${item.initialAnswer || '（無回答）'}
${item.followUpQuestion ? `・面接官の追加質問: ${item.followUpQuestion}\n・追加質問への回答: ${item.followUpAnswer || '（無回答）'}` : ''}
・所要時間: ${item.elapsedSeconds || 0}秒`;
    }).join('\n\n');

    const promptText = `あなたは新潟市立高志中等教育学校の入学者選抜（面接）の主任面接官・指導責任者です。
以下は、受検生（小学6年生）が実施した模擬面接（全${sessionAnswers.length}問）の全やり取りの記録です。

${interviewSummary}

面接全体をじっくり振り返り、受検生が本番で合格を勝ち取れるよう、受検生の実際の回答内容を具体的に引用しながら、実践的で濃密な「詳細振り返りレポート」を作成してください。
以下の要件に従い、必ず指定のJSON形式のみで出力してください:

1. goodPointsDetail: 【良かった点（具体的評価）】受検生が実際に答えた内容（「〜〜」）を具体的に引用しながら、「第〇問の〇〇において、〜〜と答えた点が、探究心や意欲が具体的に伝わり大変素晴らしいです」のように、面接官に響いた理由を詳しく解説してください（180〜250文字程度）。
2. improvementAdviceDetail: 【もっと良くなる改善案（ビフォー・アフター）】受検生の実際の回答を取り上げ、「第〇問では『〜〜』と答えていましたが、例えば『〜〜』のように具体的なエピソードや学校での活用イメージを付け加えると、さらに説得力が増して面接官の心に刺さります」という具体的なビフォー・アフターの回答例を提示してください（220〜320文字程度）。
3. mannerAdviceDetail: 【話し方のアドバイス（全体＆設問別）】3問全体を通した声のトーンやハキハキ度、話すスピードの評価に加え、「特に第〇問の（質問名）では、少し早口になった（または声が小さくなった／語尾が曖昧になった）ので、本番では〜〜を意識すると落ち着いて話せますよ」のように、改善すべき設問と具体的な話し方のコツを指導してください（160〜220文字程度）。
4. questionDetails: 各設問ごとの詳細アドバイスの配列（設問順）。各要素は以下のオブジェクト:
   - questionId: 設問ID（例: q.id）
   - deepAdvice: なぜそう話すと良いのか、面接官の視点を踏まえた詳しい深掘り解説（100〜160文字程度）。
   - concreteExample: 「例えばこのように話すと好印象です」という小学6年生向けの具体的で分かりやすい回答例・フレーズ（100〜160文字程度）。

JSONフォーマット:
{
  "goodPointsDetail": "...",
  "improvementAdviceDetail": "...",
  "mannerAdviceDetail": "...",
  "questionDetails": [
    {
      "questionId": "001",
      "deepAdvice": "...",
      "concreteExample": "..."
    }
  ]
}`;

    const payload = JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const req = https.request(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 40000
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini API HTTP ${res.statusCode}: ${data}`));
        }
        try {
          const resJson = JSON.parse(data);
          const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!rawText) return reject(new Error('No content returned from Gemini API'));
          resolve(JSON.parse(rawText));
        } catch(e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Gemini API request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

// 認証済みトークン保持マップ (token -> { username, expiresAt })
const activeTokens = new Map();

function getRegisteredUsers() {
  const raw = process.env.AUTH_USERS || '';
  const users = {};
  raw.split(',').forEach(pair => {
    const trimmed = pair.trim();
    if (!trimmed) return;
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
  const users = getRegisteredUsers();
  if (users[username] && users[username] === password) {
    return true;
  }
  return false;
}

function generateToken(username) {
  const token = crypto.randomBytes(24).toString('hex');
  // 30日間有効
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  activeTokens.set(token, { username, expiresAt });
  return token;
}

function validateToken(authHeader) {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+([a-f0-9]+)$/i);
  if (!match) return null;
  const token = match[1];
  const session = activeTokens.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    activeTokens.delete(token);
    return null;
  }
  return session;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // CORSヘッダー
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. ログイン API エンドポイント
  if (req.method === 'POST' && parsedUrl.pathname === '/api/login') {
    const bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(bodyChunks).toString('utf-8');
        const { username, password } = JSON.parse(body || '{}');
        const cleanUser = (username || '').trim();
        const cleanPass = (password || '').trim();

        if (!cleanUser || !cleanPass || !verifyCredentials(cleanUser, cleanPass)) {
          const errData = JSON.stringify({ success: false, error: 'ユーザー名またはパスワードが正しくありません' });
          res.writeHead(401, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(errData, 'utf-8')
          });
          return res.end(errData);
        }

        const token = generateToken(cleanUser);
        console.log(`[ログイン成功] ユーザー: ${cleanUser}`);
        const resData = JSON.stringify({ success: true, token, username: cleanUser });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(resData, 'utf-8')
        });
        res.end(resData);
      } catch (err) {
        const errData = JSON.stringify({ success: false, error: '不正なリクエストです' });
        res.writeHead(400, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(errData, 'utf-8')
        });
        res.end(errData);
      }
    });
    return;
  }

  // 2. 認証状態チェック API エンドポイント
  if (req.method === 'GET' && parsedUrl.pathname === '/api/auth-check') {
    const session = validateToken(req.headers.authorization);
    if (!session) {
      const errData = JSON.stringify({ authenticated: false });
      res.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(errData, 'utf-8')
      });
      return res.end(errData);
    }
    const resData = JSON.stringify({ authenticated: true, username: session.username });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(resData, 'utf-8')
    });
    res.end(resData);
    return;
  }

  // 3. Gemini 音声評価 API エンドポイント（認証必須）
  if (req.method === 'POST' && parsedUrl.pathname === '/api/evaluate-audio') {
    const session = validateToken(req.headers.authorization);
    if (!session) {
      console.warn('[未認証アクセス拒否] /api/evaluate-audio');
      const errData = JSON.stringify({ success: false, error: '認証が必要です。ログインしてください。' });
      res.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(errData, 'utf-8')
      });
      return res.end(errData);
    }
    const bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(bodyChunks).toString('utf-8');
        const payload = JSON.parse(body || '{}');
        const { audio, mimeType, question, userText } = payload;
        
        console.log(`[Gemini音声評価開始] 設問: ${question?.id || '不明'} (形式: ${mimeType || 'なし'})`);
        const evaluation = await evaluateAudioWithGemini(audio, mimeType, question, userText);
        console.log(`[Gemini音声評価完了] 設問: ${question?.id || '不明'} 結論先行: ${evaluation.isConclusionFirst}`);

        const resData = JSON.stringify({ success: true, evaluation });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(resData, 'utf-8')
        });
        res.end(resData);
      } catch (err) {
        console.error('[Gemini音声評価エラー]:', err.message || err);
        const errData = JSON.stringify({ success: false, error: err.message || String(err) });
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(errData, 'utf-8')
        });
        res.end(errData);
      }
    });
    return;
  }

  // 4. 面接全体の詳細振り返りレポート API エンドポイント（認証必須）
  if (req.method === 'POST' && parsedUrl.pathname === '/api/overall-feedback') {
    const session = validateToken(req.headers.authorization);
    if (!session) {
      const errData = JSON.stringify({ success: false, error: '認証が必要です。ログインしてください。' });
      res.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(errData, 'utf-8')
      });
      return res.end(errData);
    }
    const bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(bodyChunks).toString('utf-8');
        const payload = JSON.parse(body || '{}');
        const sessionAnswers = payload.sessionAnswers || [];
        console.log(`[総合レポート生成開始] 設問数: ${sessionAnswers.length}`);
        const report = await generateOverallFeedbackWithGemini(sessionAnswers);
        console.log('[総合レポート生成完了]');

        const resData = JSON.stringify({ success: true, report });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(resData, 'utf-8')
        });
        res.end(resData);
      } catch (err) {
        console.error('[総合レポートエラー]:', err.message || err);
        const errData = JSON.stringify({ success: false, error: err.message || String(err) });
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(errData, 'utf-8')
        });
        res.end(errData);
      }
    });
    return;
  }

  // 1. TTS API エンドポイント
  if (parsedUrl.pathname === '/api/tts') {
    const text = (parsedUrl.query.text || '').trim();
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Text is required');
      return;
    }

    const textHash = crypto.createHash('md5').update(text + '_' + VOICE).digest('hex');
    const cacheFile = path.join(CACHE_DIR, `${textHash}.mp3`);

    // キャッシュがある場合は即時返却
    if (fs.existsSync(cacheFile)) {
      try {
        const data = fs.readFileSync(cacheFile);
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': data.length,
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(data);
        return;
      } catch (e) {
        console.error('Cache read error:', e);
      }
    }

    // キャッシュがない場合はEdge-TTSで生成
    try {
      console.log(`[TTS生成中] "${text.slice(0, 30)}..."`);
      const audioBuffer = await generateVoice(text);
      fs.writeFileSync(cacheFile, audioBuffer);
      console.log(`[TTS完了] 保存: ${textHash}.mp3 (${audioBuffer.length} bytes)`);

      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length,
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(audioBuffer);
    } catch (err) {
      console.error('[TTS生成失敗]:', err.message || err);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('TTS generation error: ' + (err.message || String(err)));
    }
    return;
  }

  // 2. 静的ファイルの配信
  let reqPath = parsedUrl.pathname;
  try {
    reqPath = decodeURIComponent(reqPath);
  } catch (e) {}

  let filePath = path.join(ROOT_DIR, reqPath === '/' ? 'index.html' : reqPath);
  filePath = path.normalize(filePath);

  // ディレクトリトラバーサル防止及び隠しファイル（.env等）のアクセス遮断
  const baseName = path.basename(filePath);
  if (!filePath.startsWith(ROOT_DIR) || baseName.startsWith('.') || reqPath.includes('/.')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch (err) {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

// ポート競合（二重起動）時の安全処理
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('===================================================');
    console.log(`  すでにサーバー（ポート${PORT}）が起動しています。`);
    console.log(`  ブラウザで http://localhost:${PORT}/index.html を開きます。`);
    console.log('===================================================');
    const { exec } = require('child_process');
    exec(`start http://localhost:${PORT}/index.html`, (e) => {
      if (e) console.error('Failed to open browser:', e);
    });
  } else {
    console.error('サーバー起動エラー:', err);
  }
});

server.listen(PORT, () => {
  console.log('===================================================');
  console.log('  Koshi Junior High Interview App V2 Running');
  console.log(`  URL: http://localhost:${PORT}/index.html`);
  console.log('===================================================');
  
  // 自動でブラウザを開く
  const { exec } = require('child_process');
  exec(`start http://localhost:${PORT}/index.html`, (err) => {
    if (err) console.error('Failed to open browser:', err);
  });
});
