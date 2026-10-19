// Vercel Serverless Function: POST /api/generate-followup
const https = require('https');
const { validateToken } = require('./_auth.js');

function callGemini(url, payload) {
  return new Promise((resolve, reject) => {
    const apiReq = https.request(url, {
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
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('JSON parse error: ' + data));
        }
      });
    });

    apiReq.on('error', err => reject(err));
    apiReq.on('timeout', () => {
      apiReq.destroy();
      reject(new Error('Gemini API timeout'));
    });

    apiReq.write(payload);
    apiReq.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  // 1. 認証トークン検証
  const session = validateToken(req.headers.authorization);
  if (!session) {
    return res.status(401).json({ success: false, error: 'ログインが必要です。' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, error: 'GEMINI_API_KEY が設定されていません。' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  } else if (!body) {
    body = {};
  }

  const questionData = body.question || {};
  const studentAnswer = (body.answer || '').trim();
  const audioBase64 = body.audio;
  const mimeType = body.mimeType || 'audio/webm';

  const qText = questionData.question || '本校を志望した理由を教えてください。';
  const intent = questionData.intent || '';
  const keywords = questionData.keywords ? questionData.keywords.join(', ') : '';

  try {
    // ステップ1: 生徒の回答を踏まえた追加質問テキストをGemini 2.5 Flashで生成
    const promptText = `あなたは新潟市立高志中等教育学校の入学者選抜（面接）の面接官です。
以下の本質問に対する受験生（小学6年生）の回答を聞いて、回答内容を深掘りする自然で鋭い「追加質問」を1問だけ作成してください。
また、音声から聞き取った受験生の回答内容を「transcribedAnswer」に書き起こしてください。

【本質問】: ${qText}
【出題意図】: ${intent}
【重視キーワード】: ${keywords}
【受験生の回答】: ${studentAnswer || '（音声回答）'}

【追加質問の作成要件（最重要）】:
1. 【定型質問の厳禁】:
   「具体的にどのような工夫をしましたか？」「詳しく教えてください」といった、誰にでも使い回せる抽象的な定型質問・テンプレート質問は絶対に禁止です。
2. 【回答内容・具体語の直接引用】:
   受験生が回答の中で話した具体的な言葉（部活動名、研究テーマ、出来事、工夫、失敗、感情など）を、必ず「〇〇とおっしゃっていましたが、〜」「〇〇という経験の中で、〜」のように質問文の中に直接取り入れてください。
3. 【個別具体的な深掘り】:
   回答の文脈に合わせて、以下のいずれかの切り口から、その受検生固有の思考や主体性を引き出す質問にしてください。
   ・その場面で直面した一番の壁や、その時の率直な気持ち
   ・仲間や先生、家族など他者とどのように関わり、協力したか
   ・その経験を通じて学んだことが、高志中等での6年間の探究や生活にどう活きるか
4. 【口調と文字数】:
   小学6年生が萎縮せず安心して自分の言葉で話せるよう、丁寧で温かい面接官の口調にしてください。
   質問文の長さは50〜80文字程度にしてください。
5. 【読み上げ配慮】:
   「高志中等」は「こうしちゅうとう」、「高志」は「こうし」、「辛い」は「つらい」とひらがなで表記してください。
6. 【文字起こし（transcribedAnswer）の補完】:
   録音機器のタイミング等により、発話の最初（冒頭の挨拶や主語など）や最後（語尾の「〜です」「〜でした」「〜と考えます」など）が極僅かに途切れていても、全体の文脈から自然に補完・復元して正確に書き起こしてください。

必ず以下のJSONフォーマットのみで出力してください:
{
  "transcribedAnswer": "受験生が話した言葉の文字起こし（要約ではなく正確な発話内容）",
  "followUpQuestion": "質問文"
}`;

    const textUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const textParts = [];
    // 生徒の音声データが存在する場合はインラインで送信して直接書き起こし＆追加質問作成
    if (audioBase64) {
      textParts.push({
        inlineData: {
          mimeType: mimeType.split(';')[0],
          data: audioBase64
        }
      });
    }
    textParts.push({ text: promptText });

    const textPayload = JSON.stringify({
      contents: [{ parts: textParts }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.7,
        maxOutputTokens: 250,
        thinkingConfig: {
          thinkingBudget: 0
        }
      }
    });

    const textRes = await callGemini(textUrl, textPayload);
    let followUpText = '';
    let transcribedAnswer = studentAnswer || '';
    const rawContent = textRes.candidates?.[0]?.content?.parts?.[0]?.text;
    if (rawContent) {
      try {
        const parsed = JSON.parse(rawContent);
        followUpText = parsed.followUpQuestion || '';
        if (parsed.transcribedAnswer) {
          transcribedAnswer = parsed.transcribedAnswer;
        }
      } catch (e) {
        followUpText = rawContent;
      }
    }

    // クリーニング（改行や引用符の除去、読み間違い防止のフリガナ化）
    followUpText = followUpText.replace(/^["「]/, '').replace(/["」]$/, '').trim();
    if (!followUpText) {
      const qFallback = questionData?.followUpQuestions?.[0];
      followUpText = qFallback || "その時、どのような気持ちで取り組みましたか？";
    }

    // TTS読み上げ用テキスト（「こうし」「つらい」の読み間違いを完全防止）
    const spokenText = followUpText
      .replace(/高志中等教育学校/g, 'こうしちゅうとうきょういくがっこう')
      .replace(/高志中等/g, 'こうしちゅうとう')
      .replace(/高志/g, 'こうし')
      .replace(/辛い/g, 'つらい')
      .replace(/辛かった/g, 'つらかった')
      .replace(/辛く/g, 'つらく')
      .replace(/辛さ/g, 'つらさ')
      .replace(/辛けれ/g, 'つらけれ');

    // ステップ2: Gemini TTS (gemini-3.8-flash-lite-tts, voice: Kore) でWAV音声を高速生成
    const ttsUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent?key=${apiKey}`;
    const ttsPayload = JSON.stringify({
      contents: [{
        role: "user",
        parts: [{
          text: spokenText
        }]
      }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            voice: "Kore"
          }
        }
      }
    });

    let audioData = null;
    let audioMimeType = "audio/wav";

    try {
      const ttsRes = await callGemini(ttsUrl, ttsPayload);
      const candidatePart = ttsRes.candidates?.[0]?.content?.parts?.[0];
      if (candidatePart?.inlineData?.data) {
        audioData = candidatePart.inlineData.data;
        audioMimeType = candidatePart.inlineData.mimeType || "audio/wav";
      }
    } catch (ttsErr) {
      console.error('Gemini TTS generation error:', ttsErr.message);
      // TTSが万一失敗してもテキストは返す
    }

    // 画面表示用に「こうし」を「高志」に戻した表示用テキストも用意
    const displayText = spokenText
      .replace(/こうしちゅうとうきょういくがっこう/g, '高志中等教育学校')
      .replace(/こうしちゅうとう/g, '高志中等')
      .replace(/こうし/g, '高志');

    return res.status(200).json({
      success: true,
      questionText: displayText,
      spokenText: spokenText,
      transcribedAnswer: transcribedAnswer,
      audioBase64: audioData,
      mimeType: audioMimeType
    });

  } catch (error) {
    console.error('generate-followup API error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || '追加質問の生成に失敗しました。'
    });
  }
};
