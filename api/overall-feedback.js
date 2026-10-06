// Vercel Serverless Function: POST /api/overall-feedback
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

  const sessionAnswers = body.sessionAnswers || [];
  if (!sessionAnswers || sessionAnswers.length === 0) {
    return res.status(400).json({ success: false, error: '面接履歴がありません。' });
  }

  // 面接内容をプロンプト用に整形
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
    generationConfig: {
      responseMimeType: "application/json"
    }
  });

  const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  try {
    const report = await new Promise((resolve, reject) => {
      const apiReq = https.request(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 40000
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
            if (!rawText) return reject(new Error('テキストが返されませんでした。'));
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
        reject(new Error('タイムアウトしました。'));
      });
      apiReq.write(payload);
      apiReq.end();
    });

    return res.status(200).json({ success: true, report });
  } catch (err) {
    console.error('Overall feedback error:', err);
    return res.status(500).json({ success: false, error: err.message || '総合レポートの生成に失敗しました。' });
  }
};
