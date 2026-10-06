// Vercel Serverless Function: POST /api/evaluate-audio
const https = require('https');
const { validateToken } = require('./_auth.js');

module.exports = async function handler(req, res) {
  // CORSヘッダー
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  // 1. 認証トークンの検証
  const session = validateToken(req.headers.authorization);
  if (!session) {
    return res.status(401).json({ success: false, error: 'ログインが必要です。もう一度ログインしてください。' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, error: 'GEMINI_API_KEY が設定されていません。' });
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

  const audioBase64 = body.audio;
  const mimeType = body.mimeType || 'audio/webm';
  const questionData = body.question;
  const userText = body.userText || '';

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

  try {
    const evaluation = await new Promise((resolve, reject) => {
      const apiReq = https.request(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 30000
      }, (apiRes) => {
        const chunks = [];
        apiRes.on('data', chunk => chunks.push(chunk));
        apiRes.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf-8');
          if (apiRes.statusCode < 200 || apiRes.statusCode >= 300) {
            return reject(new Error(`Gemini API HTTP ${apiRes.statusCode}: ${data}`));
          }
          try {
            const resJson = JSON.parse(data);
            const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!rawText) return reject(new Error('Gemini APIからテキストが返されませんでした。'));
            const parsed = JSON.parse(rawText);
            resolve(parsed);
          } catch (e) {
            reject(new Error(`JSONパース失敗: ${e.message}`));
          }
        });
      });

      apiReq.on('error', (err) => reject(err));
      apiReq.on('timeout', () => {
        apiReq.destroy();
        reject(new Error('Gemini APIの呼び出しがタイムアウトしました。'));
      });
      apiReq.write(payload);
      apiReq.end();
    });

    return res.status(200).json({ success: true, evaluation });
  } catch (err) {
    console.error('Gemini evaluation error:', err);
    return res.status(500).json({ success: false, error: err.message || '評価に失敗しました。' });
  }
};
