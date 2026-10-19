// 高志中等 面接トレーニング アプリロジック (app.js)

class InterviewApp {
  constructor() {
    this.currentMode = "practice"; // "practice" | "exam"
    this.currentQuestionIndex = 0;
    this.questionList = [];
    this.currentQuestion = null;
    this.isFollowUp = false;
    this.currentFollowUpQuestion = "";
    this.sessionAnswers = []; // { question, answer, followUpAnswer, feedback }
    
    // 音声関連
    this.recognition = null;
    this.isRecognitionActive = false;
    this.isAcceptingInput = false;    // Aさんの発話受付中フラグ
    this.isSpeaking = false;          // 先生の発話中フラグ
    this.ignoredPrefixLength = 0;     // 先生の発話中に拾った文字数（除外用）
    this.isManuallyEdited = false;    // 手動編集フラグ（音声専用化に伴い無効化）
    this.currentSpeechText = "";      // 音声認識で取得した回答テキスト
    this.currentAudio = null;         // 録音音声再生用フォールバックインスタンス
    this.audioCtx = null;             // Web Audio API AudioContext
    this.audioBufferCache = new Map();// デコード済み音声バッファキャッシュ
    this.currentAudioSource = null;   // 現在再生中の AudioBufferSourceNode
    this.currentFollowUpAudioFile = null; // 現在の追加質問音声ファイルパス（固定フォールバック用）
    this.currentFollowUpAudioBase64 = null; // 動的生成された追加質問音声Base64 (Gemini TTS Kore)
    this.currentFollowUpAudioMime = "audio/wav";

    // 音声録音（MediaRecorder / Web Audio）
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.recordedAudioBlob = null;
    this.recordedMimeType = '';
    this.mediaStream = null;
    this.initialAudioBlob = null;

    // 認証情報
    this.authToken = sessionStorage.getItem("koshi_auth_token") || null;
    this.currentUsername = sessionStorage.getItem("koshi_auth_user") || null;

    // タイマー関連
    this.timerInterval = null;
    this.elapsedSeconds = 0;
    this.targetSeconds = 90; // 目安1分30秒
    
    this.initElements();
    this.initSpeech();
    this.initEvents();
    this.updateAuthUI();

    // 音声一覧を事前にウォームアップ
    if ('speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }
  }

  initElements() {
    // 画面コンテナ
    this.viewHome = document.getElementById("view-home");
    this.viewInterview = document.getElementById("view-interview");
    this.viewResult = document.getElementById("view-result");
    
    // チャットタイムライン
    this.chatTimeline = document.getElementById("chat-timeline");
    
    // ヘッダー情報
    this.modeBadge = document.getElementById("mode-badge");
    this.questionCounter = document.getElementById("question-counter");
    this.progressBar = document.getElementById("progress-bar");
    this.timerDisplay = document.getElementById("timer-display");
    
    // 面接官エリア
    this.interviewerCategory = document.getElementById("interviewer-category");
    this.interviewerStatus = document.getElementById("interviewer-status");
    this.btnReplay = document.getElementById("btn-replay");
    
    // 回答者エリア
    this.candidateStatus = document.getElementById("candidate-status");
    this.voiceVisualizer = document.getElementById("voice-visualizer");
    this.textInputContainer = document.getElementById("text-input-container");
    this.voiceAnswerContainer = document.getElementById("voice-answer-container");
    this.speechTranscript = document.getElementById("speech-transcript"); // 従来用textarea
    this.voiceTranscriptDisplay = document.getElementById("voice-transcript-display"); // 音声専用display
    this.charCount = document.getElementById("char-count");
    this.voiceCharCount = document.getElementById("voice-char-count");
    this.editBadge = document.getElementById("edit-badge");
    this.voiceIndicatorDot = document.getElementById("voice-indicator-dot");
    this.voiceGuideText = document.getElementById("voice-guide-text");
    this.btnMic = document.getElementById("btn-mic");
    this.btnSubmit = document.getElementById("btn-submit");
    this.btnStartAiVoice = document.getElementById("btn-start-ai-voice");
    
    // 右サイドバー（練習モードヒント）
    this.practiceSidebar = document.getElementById("practice-sidebar");
    this.intentText = document.getElementById("intent-text");
    this.structureChecklist = document.getElementById("structure-checklist");
    this.exampleText = document.getElementById("example-text");
    
    // レスキューボタン
    this.btnRescueRepeat = document.getElementById("btn-rescue-repeat");
    this.btnRescueThink = document.getElementById("btn-rescue-think");
    this.btnRescueRestart = document.getElementById("btn-rescue-restart");
    
    // 練習モード即時フィードバックモーダル
    this.feedbackModal = document.getElementById("feedback-modal");
    this.modalFeedbackContent = document.getElementById("modal-feedback-content");
    this.btnModalNext = document.getElementById("btn-modal-next");

    // 認証関連
    this.userDisplay = document.getElementById("user-display");
    this.btnAuthAction = document.getElementById("btn-auth-action");
    this.loginModal = document.getElementById("login-modal");
    this.loginForm = document.getElementById("login-form");
    this.loginUsername = document.getElementById("login-username");
    this.loginPassword = document.getElementById("login-password");
    this.loginErrorMsg = document.getElementById("login-error-msg");
  }

  initSpeech() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("Web Speech Recognition is not supported in this browser.");
    }
  }

  // --- Web Audio API 初期化（コンプレッサー＆マスターゲインによる音量均一化） ---
  async initAudioContext() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
        try {
          // 音量のばらつき（急激な大小変化）を抑えて均一化するコンプレッサー
          this.compressor = this.audioCtx.createDynamicsCompressor();
          this.compressor.threshold.setValueAtTime(-24, this.audioCtx.currentTime);
          this.compressor.knee.setValueAtTime(30, this.audioCtx.currentTime);
          this.compressor.ratio.setValueAtTime(12, this.audioCtx.currentTime);
          this.compressor.attack.setValueAtTime(0.003, this.audioCtx.currentTime);
          this.compressor.release.setValueAtTime(0.25, this.audioCtx.currentTime);

          // マスターゲイン
          this.masterGain = this.audioCtx.createGain();
          this.masterGain.gain.setValueAtTime(1.0, this.audioCtx.currentTime);

          this.compressor.connect(this.masterGain);
          this.masterGain.connect(this.audioCtx.destination);
        } catch (e) {
          console.warn("コンプレッサーの初期化に失敗しました:", e);
        }
      }
    }
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      try {
        await this.audioCtx.resume();
      } catch (e) {
        console.warn("AudioContext resume failed:", e);
      }
    }
  }

  // --- 音声バッファのピーク検出と正規化ゲイン計算（音量自動ノーマライズ） ---
  calculateNormalizeGain(audioBuffer, targetPeak = 0.85) {
    if (!audioBuffer) return 1.0;
    try {
      let maxPeak = 0;
      const numChannels = audioBuffer.numberOfChannels;
      for (let c = 0; c < numChannels; c++) {
        const data = audioBuffer.getChannelData(c);
        const step = Math.max(1, Math.floor(data.length / 5000)); // 高速サンプリング
        for (let i = 0; i < data.length; i += step) {
          const val = Math.abs(data[i]);
          if (val > maxPeak) maxPeak = val;
        }
      }
      if (maxPeak < 0.05) return 1.0; // 極小音・無音はそのまま
      const gain = targetPeak / maxPeak;
      return Math.min(Math.max(gain, 0.4), 2.2); // 極端な増幅・減衰を抑えるリミット
    } catch (e) {
      return 1.0;
    }
  }

  // --- 音声バッファの取得とデコード（メモリキャッシュ付き） ---
  async loadAudioBuffer(url) {
    if (!url) return null;
    if (this.audioBufferCache.has(url)) {
      return this.audioBufferCache.get(url);
    }
    this.initAudioContext();
    if (!this.audioCtx) return null;

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
      this.audioBufferCache.set(url, audioBuffer);
      return audioBuffer;
    } catch (e) {
      console.warn("音声バッファの取得/デコードに失敗しました:", url, e);
      return null;
    }
  }

  // --- 全設問音声のバックグラウンド事前プリロード（Safariで2問目から音が出なくなる問題を完全解消） ---
  preloadAllQuestionAudios() {
    if (typeof INTERVIEW_QUESTIONS === "undefined" || !Array.isArray(INTERVIEW_QUESTIONS)) return;
    this.initAudioContext();
    setTimeout(() => {
      INTERVIEW_QUESTIONS.forEach(q => {
        const path = this.getVoiceFilePath(q.id);
        if (path && !this.audioBufferCache.has(path)) {
          this.loadAudioBuffer(path).catch(() => {});
        }
      });
    }, 100);
  }

  // --- 認証付きAPI呼び出し共通ヘルパー ---
  fetchWithAuth(url, options = {}) {
    const headers = options.headers || {};
    return fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken || ''}`,
        ...headers
      }
    });
  }

  // --- 音声認識インスタンスの都度生成（※iOSのインスタンス再利用不可バグを完全回避） ---
  createRecognitionInstance() {
    if (this.recognition) {
      try {
        this.recognition.onend = null;
        this.recognition.onerror = null;
        this.recognition.stop();
      } catch(e) {}
      this.recognition = null;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;

    // iOS 16.4+ 録音セッション指定
    if (navigator.audioSession) {
      try {
        navigator.audioSession.type = "play-and-record";
      } catch(e) {}
    }

    const rec = new SpeechRecognition();
    rec.lang = "ja-JP";
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = () => {
      this.isRecognitionActive = true;
      if (this.candidateStatus) {
        this.candidateStatus.innerText = "🎙 音声を認識しています… お話しください";
      }
    };

    rec.onresult = (event) => {
      // 先生が話している間、または入力受付前は処理しない
      if (!this.isAcceptingInput || this.isSpeaking) {
        return;
      }

      // 今回のターンの発話テキストを抽出
      let turnText = "";
      for (let i = 0; i < event.results.length; ++i) {
        turnText += event.results[i][0].transcript;
      }

      this.currentSpeechText = turnText;

      if (this.currentMode === "ai-voice") {
        // AI実践モード：文字は画面に表示せず、音声認識中ステータスのみ表示
        if (this.voiceGuideText) {
          this.voiceGuideText.innerText = "音声を認識しています… 話し終えたら「回答完了」を押してください";
        }
        if (this.voiceIndicatorDot) {
          this.voiceIndicatorDot.className = "w-2.5 h-2.5 rounded-full bg-secondary animate-ping";
        }
      } else {
        // 従来モード（練習・本番）：手動編集されていない場合のみテキストエリアに自動反映
        if (!this.isManuallyEdited && this.speechTranscript) {
          this.speechTranscript.value = turnText;
        }
        if (this.charCount) {
          const len = this.speechTranscript ? this.speechTranscript.value.length : turnText.length;
          this.charCount.innerText = `${len} 文字`;
        }
      }
    };

    rec.onerror = (event) => {
      // aborted や no-speech は通常の切断・無音イベントのため無視（エラーとして表示しない）
      if (event.error === "aborted" || event.error === "no-speech") {
        return;
      }
      console.warn("Speech recognition error:", event.error);
      if (this.candidateStatus) {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          this.candidateStatus.innerText = "🎙 音声を録音中… 話し終えたら完了を押してください";
        } else {
          this.candidateStatus.innerText = `マイク状況: ${event.error}`;
        }
      }
    };

    rec.onend = () => {
      this.isRecognitionActive = false;
      // ユーザーが回答中（録音中）であれば新しいインスタンスで安全に復帰（インスタンス再利用によるabortedバグを完全回避）
      if (this.isAcceptingInput && !this.isSpeaking && this.viewInterview && !this.viewInterview.classList.contains("hidden")) {
        setTimeout(() => {
          if (this.isAcceptingInput && !this.isSpeaking) {
            this.ensureRecognitionActive();
          }
        }, 150);
      }
    };

    this.recognition = rec;
    return rec;
  }

  initEvents() {
    // 認証ボタン・フォーム
    if (this.btnAuthAction) {
      this.btnAuthAction.addEventListener("click", () => {
        if (this.authToken) {
          if (confirm("ログアウトしますか？")) {
            this.handleLogout();
          }
        } else {
          this.showLoginModal();
        }
      });
    }

    if (this.loginForm) {
      this.loginForm.addEventListener("submit", (e) => this.handleLogin(e));
    }

    const btnLoginClose = document.getElementById("btn-login-close");
    if (btnLoginClose) {
      btnLoginClose.addEventListener("click", () => this.hideLoginModal());
    }

    if (this.loginModal) {
      this.loginModal.addEventListener("click", (e) => {
        if (e.target === this.loginModal) {
          this.hideLoginModal();
        }
      });
    }

    // ホーム画面
    document.getElementById("btn-start-practice").addEventListener("click", () => {
      this.initAudioContext();
      this.startPracticeMode();
    });
    document.getElementById("btn-start-exam").addEventListener("click", () => {
      this.initAudioContext();
      this.startExamMode();
    });
    if (this.btnStartAiVoice) {
      this.btnStartAiVoice.addEventListener("click", () => {
        this.initAudioContext();
        this.startAiVoiceMode();
      });
    }
    
    // 再生ボタン
    this.btnReplay.addEventListener("click", () => {
      this.initAudioContext();
      if (this.isFollowUp) {
        if (this.currentFollowUpAudioBase64) {
          this.setInputAcceptance(false);
          this.updateActionButton("speaking");
          this.interviewerStatus.innerHTML = `
            <span class="w-2 h-2 rounded-full bg-tertiary"></span>
            <span>追加質問を読み上げています…</span>
          `;
          this.playBase64Audio(this.currentFollowUpAudioBase64, this.currentFollowUpAudioMime, () => {
            this.interviewerStatus.innerHTML = `
              <span class="w-2 h-2 rounded-full bg-secondary"></span>
              <span>追加質問に答えてみましょう。</span>
            `;
            this.startAnsweringTurn();
          });
        } else if (this.currentFollowUpAudioFile) {
          this.setInputAcceptance(false);
          this.updateActionButton("speaking");
          this.interviewerStatus.innerHTML = `
            <span class="w-2 h-2 rounded-full bg-tertiary"></span>
            <span>追加質問を読み上げています…</span>
          `;
          this.playAudioFile(this.currentFollowUpAudioFile, () => {
            this.interviewerStatus.innerHTML = `
              <span class="w-2 h-2 rounded-full bg-secondary"></span>
              <span>追加質問に答えてみましょう。</span>
            `;
            this.startAnsweringTurn();
          });
        } else if (this.currentFollowUpQuestion) {
          this.setInputAcceptance(false);
          this.updateActionButton("speaking");
          this.interviewerStatus.innerHTML = `
            <span class="w-2 h-2 rounded-full bg-tertiary"></span>
            <span>追加質問を読み上げています…</span>
          `;
          this.speakText(this.currentFollowUpQuestion, () => {
            this.interviewerStatus.innerHTML = `
              <span class="w-2 h-2 rounded-full bg-secondary"></span>
              <span>追加質問に答えてみましょう。</span>
            `;
            this.startAnsweringTurn();
          });
        } else {
          this.startAnsweringTurn();
        }
      } else if (this.currentQuestion) {
        this.setInputAcceptance(false);
        this.updateActionButton("speaking");
        this.interviewerStatus.innerHTML = `
          <span class="w-2 h-2 rounded-full bg-secondary"></span>
          <span>質問を読み上げ中…</span>
        `;
        this.playQuestionAudio(this.currentQuestion.id, () => {
          this.interviewerStatus.innerHTML = `
            <span class="w-2 h-2 rounded-full bg-secondary"></span>
            <span>あなたの番です。落ち着いて話してください。</span>
          `;
          this.startAnsweringTurn();
        });
      }
    });

    // マイクON/OFF（手動切替）
    this.btnMic.addEventListener("click", () => {
      if (this.isSpeaking) return; // 先生の発話中はマイク操作不可

      if (this.isAcceptingInput) {
        this.setInputAcceptance(false);
        this.updateActionButton("ready");
      } else {
        this.setInputAcceptance(true);
        this.updateActionButton("recording");
      }
    });

    // 回答アクションボタン（1回目: タップして話す / 2回目: 送信）
    this.btnSubmit.addEventListener("click", () => this.handleActionClick());

    // 従来モード用：テキストエリア直接入力イベント（手動編集の検知）
    if (this.speechTranscript) {
      this.speechTranscript.addEventListener("input", () => {
        if (this.currentMode !== "ai-voice") {
          this.isManuallyEdited = true;
          if (this.editBadge) this.editBadge.classList.remove("hidden");
          if (this.charCount) this.charCount.innerText = `${this.speechTranscript.value.length} 文字`;
        }
      });
    }

    // レスキューボタン
    this.btnRescueRepeat.addEventListener("click", () => this.handleRescue("repeat"));
    this.btnRescueThink.addEventListener("click", () => this.handleRescue("think"));
    this.btnRescueRestart.addEventListener("click", () => this.handleRescue("restart"));

    // モード切替・終了
    document.getElementById("btn-exit-interview").addEventListener("click", () => {
      if (confirm("面接練習を終了してホームに戻りますか？")) {
        this.setInputAcceptance(false);
        this.stopRecognitionCompletely();
        this.stopAllAudio();
        this.stopTimer();
        this.showView("home");
      }
    });

    // 結果画面からホームへ
    document.getElementById("btn-result-home").addEventListener("click", () => {
      this.stopRecognitionCompletely();
      this.showView("home");
    });

    document.getElementById("btn-result-retry").addEventListener("click", () => {
      if (this.currentMode === "exam") {
        this.startExamMode();
      } else if (this.currentMode === "ai-voice") {
        this.startAiVoiceMode();
      } else {
        this.startPracticeMode();
      }
    });
  }

  showView(viewName) {
    this.viewHome.classList.add("hidden");
    this.viewInterview.classList.add("hidden");
    this.viewResult.classList.add("hidden");

    if (viewName === "home") this.viewHome.classList.remove("hidden");
    if (viewName === "interview") this.viewInterview.classList.remove("hidden");
    if (viewName === "result") this.viewResult.classList.remove("hidden");
  }

  ensureRecognitionActive() {
    // iOS対策：毎回フレッシュな音声認識インスタンスをゼロから生成して起動
    const rec = this.createRecognitionInstance();
    if (rec) {
      try {
        rec.start();
      } catch (e) {
        console.warn("Recognition start failed:", e);
      }
    }
  }

  stopRecognitionCompletely() {
    this.isAcceptingInput = false;
    this.updateMicUI(false);
    if (this.recognition) {
      try {
        this.recognition.onend = null;
        this.recognition.onerror = null;
        this.recognition.stop();
      } catch(e) {}
      this.recognition = null; // 破棄して次回のターンで新しく作り直す
    }
    this.isRecognitionActive = false;
    if (navigator.audioSession) {
      try {
        navigator.audioSession.type = "playback";
      } catch(e) {}
    }
  }

  // --- 音声録音（MediaRecorder）の開始 ---
  async startRecordingAudio() {
    this.audioChunks = [];
    this.recordedAudioBlob = null;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.warn("getUserMedia is not supported on this browser/context.");
        return false;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
      } catch (err) {
        console.warn("getUserMedia with advanced constraints failed, falling back to simple audio:", err);
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      this.mediaStream = stream;

      const mimeType = this.getSupportedAudioMimeType();
      const options = mimeType ? { mimeType } : {};
      const recorder = new MediaRecorder(stream, options);
      this.mediaRecorder = recorder;
      this.recordedMimeType = recorder.mimeType || mimeType || 'audio/mp4';

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.audioChunks.push(e.data);
        }
      };

      recorder.start(200);
      return true;
    } catch (err) {
      console.warn("Failed to start MediaRecorder:", err);
      return false;
    }
  }

  // --- 音声録音の停止とBlob化 ---
  stopRecordingAudio() {
    return new Promise((resolve) => {
      const restoreSession = () => {
        if (navigator.audioSession) {
          try {
            navigator.audioSession.type = "playback";
          } catch(e) {}
        }
        if (this.audioCtx && this.audioCtx.state === "suspended") {
          try { this.audioCtx.resume(); } catch(e) {}
        }
      };

      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        if (this.mediaStream) {
          this.mediaStream.getTracks().forEach(t => {
            try { t.stop(); } catch(e) {}
          });
          this.mediaStream = null;
        }
        restoreSession();
        resolve(this.recordedAudioBlob || null);
        return;
      }

      this.mediaRecorder.onstop = () => {
        const mime = this.recordedMimeType || 'audio/mp4';
        const blob = new Blob(this.audioChunks, { type: mime });
        this.recordedAudioBlob = blob;
        if (this.mediaStream) {
          this.mediaStream.getTracks().forEach(t => {
            try { t.stop(); } catch(e) {}
          });
          this.mediaStream = null;
        }
        this.mediaRecorder = null;
        restoreSession();
        resolve(blob);
      };

      try {
        this.mediaRecorder.stop();
      } catch (e) {
        console.warn("Error stopping MediaRecorder:", e);
        if (this.mediaStream) {
          this.mediaStream.getTracks().forEach(t => {
            try { t.stop(); } catch(e) {}
          });
          this.mediaStream = null;
        }
        this.mediaRecorder = null;
        restoreSession();
        resolve(null);
      }
    });
  }

  getSupportedAudioMimeType() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/aac',
      'audio/wav'
    ];
    for (const t of types) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
        return t;
      }
    }
    return '';
  }

  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result ? reader.result.split(',')[1] : '';
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  setInputAcceptance(accepting) {
    this.isAcceptingInput = accepting;
    this.updateMicUI(accepting);
    if (accepting) {
      if (!this.isSpeaking) {
        this.ensureRecognitionActive();
      }
    } else {
      this.stopRecognitionCompletely();
    }
  }

  // --- チャットタイムライン操作 ---
  addSystemDivider(text) {
    if (!this.chatTimeline) return;
    const div = document.createElement("div");
    div.className = "flex items-center justify-center my-1";
    div.innerHTML = `
      <span class="px-3 py-1 rounded-full bg-surface-container text-on-surface-variant text-[11px] font-medium border border-surface-variant/40 shadow-xs">
        ${text}
      </span>
    `;
    this.chatTimeline.appendChild(div);
    this.scrollChatToBottom();
  }

  addChatMessage(sender, text, options = {}) {
    if (!this.chatTimeline) return;
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const div = document.createElement("div");

    if (sender === "interviewer") {
      const isFollowUp = options.isFollowUp || false;
      const roleLabel = isFollowUp ? "面接官（追加質問）" : "面接官";
      const bubbleBorder = isFollowUp ? "border-tertiary/40 bg-amber-50/50" : "border-surface-container bg-surface-container-lowest";

      div.className = "flex items-start gap-2.5 max-w-[92%] sm:max-w-[85%]";
      div.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-primary-container text-on-primary flex items-center justify-center font-bold text-xs flex-shrink-0 shadow-xs">
          先
        </div>
        <div class="space-y-1">
          <div class="flex items-center gap-1.5">
            <span class="text-[11px] font-bold text-primary">${roleLabel}</span>
            <span class="text-[10px] text-outline">${timeStr}</span>
          </div>
          <div class="p-3 sm:p-3.5 rounded-2xl rounded-tl-none ${bubbleBorder} text-on-surface shadow-xs border text-xs sm:text-sm leading-relaxed whitespace-pre-wrap">${text.trim()}</div>
        </div>
      `;
    } else {
      const userName = this.currentUsername || "受検生";
      const initialChar = userName.charAt(0) || "受";
      div.className = "flex items-start gap-2.5 max-w-[92%] sm:max-w-[85%]" + " ml-auto flex-row-reverse";
      div.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-secondary-fixed text-on-secondary-fixed-variant flex items-center justify-center font-bold text-xs flex-shrink-0 shadow-xs">
          ${initialChar}
        </div>
        <div class="space-y-1 text-right">
          <div class="flex items-center justify-end gap-1.5">
            <span class="text-[10px] text-outline">${timeStr}</span>
            <span class="text-[11px] font-bold text-secondary">${userName}さん</span>
          </div>
          <div class="p-3 sm:p-3.5 rounded-2xl rounded-tr-none bg-secondary-container text-on-secondary-container shadow-xs border border-secondary/20 text-xs sm:text-sm leading-relaxed text-left whitespace-pre-wrap">${text.trim()}</div>
        </div>
      `;
    }

    this.chatTimeline.appendChild(div);
    this.scrollChatToBottom();
  }

  updateLastCandidateMessage(newText) {
    if (!this.chatTimeline || !newText) return;
    const candidateBubbles = this.chatTimeline.querySelectorAll(".ml-auto");
    if (candidateBubbles.length > 0) {
      const lastBubble = candidateBubbles[candidateBubbles.length - 1];
      const textDiv = lastBubble.querySelector(".rounded-2xl");
      if (textDiv) {
        textDiv.textContent = newText.trim();
      }
    }
  }

  scrollChatToBottom() {
    if (!this.chatTimeline) return;
    setTimeout(() => {
      this.chatTimeline.scrollTop = this.chatTimeline.scrollHeight;
    }, 50);
  }

  // --- 練習モード開始（優先度を考慮したランダム3問） ---
  async startPracticeMode(selectedQId = null) {
    if (!this.authToken) {
      this.showLoginModal();
      return;
    }
    this.preloadAllQuestionAudios();
    this.currentMode = "practice";
    if (selectedQId) {
      this.questionList = INTERVIEW_QUESTIONS.filter(q => q.id === selectedQId);
    } else {
      // 優先度Sから1問、Aから1問、BまたはCから1問をランダム抽出（計3問）
      const s = this.shuffle([...INTERVIEW_QUESTIONS.filter(q => q.priority === "S")])[0];
      const a = this.shuffle([...INTERVIEW_QUESTIONS.filter(q => q.priority === "A")])[0];
      const bc = this.shuffle([...INTERVIEW_QUESTIONS.filter(q => q.priority === "B" || q.priority === "C")])[0];
      this.questionList = [s, a, bc];
    }
    this.currentQuestionIndex = 0;
    this.sessionAnswers = [];
    if (this.chatTimeline) this.chatTimeline.innerHTML = "";
    this.addSystemDivider("練習モードを開始しました（全3問）");
    this.setupInterviewScreen();
    await this.getVoicesAsync();
    this.loadQuestion();
  }

  // --- 本番モード開始 ---
  async startExamMode() {
    if (!this.authToken) {
      this.showLoginModal();
      return;
    }
    this.preloadAllQuestionAudios();
    this.currentMode = "exam";
    const sList = this.shuffle([...INTERVIEW_QUESTIONS.filter(q => q.priority === "S")]).slice(0, 3);
    const aList = this.shuffle([...INTERVIEW_QUESTIONS.filter(q => q.priority === "A")]).slice(0, 2);
    const bcList = this.shuffle([...INTERVIEW_QUESTIONS.filter(q => q.priority === "B" || q.priority === "C")]).slice(0, 1);
    
    this.questionList = [...sList, ...aList, ...bcList];
    this.currentQuestionIndex = 0;
    this.sessionAnswers = [];
    if (this.chatTimeline) this.chatTimeline.innerHTML = "";
    this.addSystemDivider(`本番モードを開始しました（全${this.questionList.length}問）`);
    this.setupInterviewScreen();
    await this.getVoicesAsync();
    this.loadQuestion();
  }

  // --- AI実践モード開始（音声専任・動的追加質問、全3問） ---
  async startAiVoiceMode() {
    if (!this.authToken) {
      this.showLoginModal();
      return;
    }
    this.preloadAllQuestionAudios();
    this.currentMode = "ai-voice";
    const s = this.shuffle([...INTERVIEW_QUESTIONS.filter(q => q.priority === "S")])[0];
    const a = this.shuffle([...INTERVIEW_QUESTIONS.filter(q => q.priority === "A")])[0];
    const bc = this.shuffle([...INTERVIEW_QUESTIONS.filter(q => q.priority === "B" || q.priority === "C")])[0];
    this.questionList = [s, a, bc];

    this.currentQuestionIndex = 0;
    this.sessionAnswers = [];
    if (this.chatTimeline) this.chatTimeline.innerHTML = "";
    this.addSystemDivider("AI実践モードを開始しました（音声専任・全3問）");
    this.setupInterviewScreen();
    await this.getVoicesAsync();
    this.loadQuestion();
  }

  shuffle(array) {
    return array.sort(() => Math.random() - 0.5);
  }

  setupInterviewScreen() {
    this.showView("interview");
    if (this.currentMode === "practice") {
      this.modeBadge.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-secondary animate-pulse flex-shrink-0"></span>
        <span class="truncate">① 練習モード</span>
      `;
      this.practiceSidebar.classList.remove("hidden");
      if (this.textInputContainer) this.textInputContainer.classList.remove("hidden");
      if (this.voiceAnswerContainer) this.voiceAnswerContainer.classList.add("hidden");
    } else if (this.currentMode === "exam") {
      this.modeBadge.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-primary animate-pulse flex-shrink-0"></span>
        <span class="font-bold text-primary truncate">② 本番モード</span>
      `;
      this.practiceSidebar.classList.add("hidden");
      if (this.textInputContainer) this.textInputContainer.classList.remove("hidden");
      if (this.voiceAnswerContainer) this.voiceAnswerContainer.classList.add("hidden");
    } else {
      // ai-voice
      this.modeBadge.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-tertiary animate-pulse flex-shrink-0"></span>
        <span class="font-bold text-tertiary truncate">③ AI実践モード（音声）</span>
      `;
      this.practiceSidebar.classList.add("hidden");
      if (this.textInputContainer) this.textInputContainer.classList.add("hidden");
      if (this.voiceAnswerContainer) this.voiceAnswerContainer.classList.remove("hidden");
    }
  }

  loadQuestion() {
    this.currentQuestion = this.questionList[this.currentQuestionIndex];
    this.isFollowUp = false;
    this.currentFollowUpQuestion = "";
    
    this.resetInputArea();
    this.setInputAcceptance(false);

    // ヘッダー進捗更新
    const total = this.questionList.length;
    const currentNum = this.currentQuestionIndex + 1;
    this.questionCounter.innerHTML = `
      <span class="text-primary font-bold">第 ${currentNum} 問</span>
      <span class="text-on-surface-variant">/ ${total}問</span>
    `;
    this.progressBar.style.width = `${(currentNum / total) * 100}%`;

    // タイムラインに設問の区切りを表示
    this.addSystemDivider(`第 ${currentNum} 問 / 全${total}問 （${this.currentQuestion.category}）`);

    // 面接官情報
    this.interviewerCategory.innerText = `${this.currentQuestion.category}（優先度 ${this.currentQuestion.priority}）`;
    this.interviewerStatus.innerHTML = `
      <span class="w-2 h-2 rounded-full bg-secondary"></span>
      <span>質問を読み上げ中…</span>
    `;

    // タイムラインに先生の質問を追加
    this.addChatMessage("interviewer", this.currentQuestion.question, { isFollowUp: false });

    // 練習サイドバー情報
    if (this.currentMode === "practice") {
      this.intentText.innerText = this.currentQuestion.intent;
      this.structureChecklist.innerHTML = this.renderChecklist(this.currentQuestion.structure);
      this.exampleText.innerText = this.currentQuestion.example;
    }

    // タイマーリセット
    this.startTimer();
    this.updateActionButton("speaking");

    // 録音音声の読み上げ
    this.playQuestionAudio(this.currentQuestion.id, () => {
      this.interviewerStatus.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-secondary"></span>
        <span>あなたの番です。落ち着いて話してください。</span>
      `;
      this.startAnsweringTurn();
    });
  }

  resetInputArea() {
    this.isManuallyEdited = false;
    this.currentSpeechText = "";
    if (this.editBadge) this.editBadge.classList.add("hidden");
    
    // 従来用textarea
    if (this.speechTranscript) {
      this.speechTranscript.value = "";
    }
    if (this.charCount) this.charCount.innerText = "0 文字";

    // 音声専用ステータス
    if (this.voiceGuideText) this.voiceGuideText.innerText = "マイクボタンを押して回答をお話しください。話し終えたら完了ボタンを押します。";
    if (this.voiceIndicatorDot) this.voiceIndicatorDot.className = "w-2.5 h-2.5 rounded-full bg-outline";
  }

  startAnsweringTurn() {
    this.resetInputArea();
    this.isSpeaking = false;
    this.setInputAcceptance(false); // 自動起動はせずユーザーのタップ待ちにする
    this.candidateStatus.innerText = "「タップして話す」を押して回答を始めてください";
    this.updateActionButton("ready");
  }

  renderChecklist(structureStr) {
    const parts = structureStr.split("➔");
    return parts.map(part => `
      <li class="flex items-center gap-1.5 text-caption font-caption text-on-surface">
        <span class="text-secondary font-bold">✔</span>
        <span>${part.trim()}</span>
      </li>
    `).join("");
  }

  // --- アクションボタン（タップして話す / 送信）の表示制御 ---
  updateActionButton(state) {
    if (!this.btnSubmit) return;

    if (state === "speaking") {
      this.btnSubmit.disabled = true;
      this.btnSubmit.className = "flex-1 py-3 px-4 rounded-xl bg-surface-container-high text-on-surface-variant font-bold opacity-60 cursor-not-allowed flex items-center justify-center gap-2 text-sm sm:text-base transition-all";
      this.btnSubmit.innerHTML = `
        <span class="material-symbols-outlined text-[18px] animate-spin">hourglass_empty</span>
        <span>質問を読み上げ中…</span>
      `;
    } else if (state === "ready") {
      this.btnSubmit.disabled = false;
      this.btnSubmit.className = "flex-1 py-3 px-4 rounded-xl bg-secondary text-on-secondary font-bold hover:bg-opacity-95 shadow-lg animate-pulse active:scale-95 flex items-center justify-center gap-2 text-sm sm:text-base transition-all cursor-pointer";
      this.btnSubmit.innerHTML = `
        <span class="material-symbols-outlined text-[20px]">mic</span>
        <span>タップして話す（回答開始）</span>
      `;
    } else if (state === "recording") {
      this.btnSubmit.disabled = false;
      this.btnSubmit.className = "flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-primary-container to-secondary text-on-primary font-bold hover:opacity-95 shadow-md active:scale-95 flex items-center justify-center gap-2 text-sm sm:text-base transition-all cursor-pointer";
      const submitText = (this.currentMode === "ai-voice") ? "話し終わりました（回答完了）" : "この内容で回答を送信する";
      this.btnSubmit.innerHTML = `
        <span>${submitText}</span>
        <span class="material-symbols-outlined text-[18px]">arrow_forward</span>
      `;
    } else if (state === "analyzing") {
      this.btnSubmit.disabled = true;
      this.btnSubmit.className = "flex-1 py-3 px-4 rounded-xl bg-surface-container-high text-on-surface-variant font-bold opacity-80 cursor-wait flex items-center justify-center gap-2 text-sm sm:text-base transition-all";
      this.btnSubmit.innerHTML = `
        <span class="material-symbols-outlined text-[20px] animate-spin">sync</span>
        <span>AIが音声を直接判定中…</span>
      `;
    }
  }

  // --- アクションボタンクリック処理（タップして話す / 送信の分岐） ---
  async handleActionClick() {
    this.initAudioContext();
    if (this.isSpeaking) return;

    if (!this.isAcceptingInput) {
      // 1回目のタップ：マイク録音を開始
      this.isManuallyEdited = false;
      if (this.editBadge) this.editBadge.classList.add("hidden");
      this.resetInputArea();

      await this.startRecordingAudio();
      this.setInputAcceptance(true);
      this.updateActionButton("recording");
      if (this.candidateStatus) {
        this.candidateStatus.innerText = "🎙 録音中… 回答をお話しください";
      }
    } else {
      // 2回目のタップ：回答完了・音声送信＆AI判定
      await this.handleSubmitAnswer();
    }
  }

  // --- 回答完了処理 ---
  async handleSubmitAnswer() {
    this.updateActionButton("analyzing");
    if (this.candidateStatus) {
      this.candidateStatus.innerText = "🤖 音声を分析しています…";
    }

    // ケツ切れ防止：話し終わりの語尾（〜です、〜でした等）を漏らさないよう500msの余韻バッファを自動確保
    await new Promise(resolve => setTimeout(resolve, 500));

    this.setInputAcceptance(false);

    // 録音停止＆Blob取得
    const audioBlob = await this.stopRecordingAudio();
    const answerText = (this.currentMode === "ai-voice")
      ? this.currentSpeechText.trim()
      : (this.speechTranscript ? this.speechTranscript.value.trim() : this.currentSpeechText.trim());

    // タイムラインに受検者の発言を追加
    const displayText = answerText || "🎙（音声を録音・送信しました）";
    this.addChatMessage("candidate", displayText);

    // 追加質問（深掘り）の判定
    if (!this.isFollowUp && this.currentQuestion.followUpQuestions && this.currentQuestion.followUpQuestions.length > 0) {
      const shouldFollowUp = (this.currentMode === "exam") 
        ? (this.currentQuestion.priority === "S" || Math.random() > 0.4)
        : true;

      if (shouldFollowUp) {
        this.initialAudioBlob = audioBlob;
        if (this.currentMode === "ai-voice") {
          // AI実践モード：Geminiによる動的質問生成＆Kore音声再生
          await this.triggerDynamicFollowUp(answerText || "（音声回答）", audioBlob);
        } else {
          // 従来モード（練習・本番）：固定追加質問＆事前生成WAV再生
          this.triggerStaticFollowUp(answerText || "（音声回答）");
        }
        return;
      }
    }

    await this.finishCurrentQuestion(answerText, audioBlob);
  }

  // --- 従来モード用：固定追加質問の発動（※事前生成WAV音声の再生） ---
  triggerStaticFollowUp(initialAnswer) {
    this.isFollowUp = true;
    this.initialAnswer = initialAnswer;
    this.currentFollowUpAudioBase64 = null;

    const followUps = this.currentQuestion.followUpQuestions || [];
    const randomIndex = Math.floor(Math.random() * followUps.length);
    this.currentFollowUpQuestion = followUps[randomIndex] || "具体的に教えてください。";

    const addNumStr = String(randomIndex + 1).padStart(2, "0");
    this.currentFollowUpAudioFile = `VOICE/${this.currentQuestion.id}_add${addNumStr}.wav`;

    this.resetInputArea();
    this.setInputAcceptance(false);
    this.updateActionButton("speaking");
    this.interviewerStatus.innerHTML = `
      <span class="w-2 h-2 rounded-full bg-tertiary"></span>
      <span>回答を確認しています…</span>
    `;

    setTimeout(() => {
      this.addChatMessage("interviewer", this.currentFollowUpQuestion, { isFollowUp: true });
      this.interviewerStatus.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-tertiary"></span>
        <span>追加質問を読み上げています…</span>
      `;

      this.playAudioFile(this.currentFollowUpAudioFile, () => {
        this.interviewerStatus.innerHTML = `
          <span class="w-2 h-2 rounded-full bg-secondary"></span>
          <span>追加質問に答えてみましょう。</span>
        `;
        this.startAnsweringTurn();
      });
    }, 500);
  }

  // --- AI実践モード用：追加質問の発動（※Gemini動的質問生成＆Kore音声再生） ---
  async triggerDynamicFollowUp(initialAnswer, audioBlob = null) {
    this.isFollowUp = true;
    this.initialAnswer = initialAnswer;
    this.currentFollowUpAudioBase64 = null;
    this.currentFollowUpAudioFile = null;

    this.resetInputArea();
    this.setInputAcceptance(false);
    this.updateActionButton("speaking");
    this.interviewerStatus.innerHTML = `
      <span class="w-2 h-2 rounded-full bg-tertiary animate-pulse"></span>
      <span>回答を確認し、次の質問を考えています…</span>
    `;

    try {
      let audioBase64 = null;
      let mimeType = this.recordedMimeType || "audio/mp4";
      if (audioBlob && audioBlob.size > 0) {
        mimeType = audioBlob.type || this.recordedMimeType || "audio/mp4";
        audioBase64 = await this.blobToBase64(audioBlob);
      }

      // 動的追加質問API呼び出し
      const res = await this.fetchWithAuth("/api/generate-followup", {
        method: "POST",
        body: JSON.stringify({
          question: this.currentQuestion,
          answer: initialAnswer,
          audio: audioBase64,
          mimeType: mimeType
        })
      });

      const data = await res.json();
      if (!data.success || !data.questionText) {
        throw new Error(data.error || "動的質問の生成に失敗しました");
      }

      this.currentFollowUpQuestion = data.questionText;
      this.currentFollowUpAudioBase64 = data.audioBase64;
      this.currentFollowUpAudioMime = data.mimeType || "audio/wav";

      if (data.transcribedAnswer) {
        this.initialAnswer = data.transcribedAnswer;
        this.updateLastCandidateMessage(data.transcribedAnswer);
      }

      this.addChatMessage("interviewer", this.currentFollowUpQuestion, { isFollowUp: true });
      this.interviewerStatus.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-tertiary"></span>
        <span>追加質問を読み上げています…</span>
      `;

      if (this.currentFollowUpAudioBase64) {
        this.playBase64Audio(this.currentFollowUpAudioBase64, this.currentFollowUpAudioMime, () => {
          this.interviewerStatus.innerHTML = `
            <span class="w-2 h-2 rounded-full bg-secondary"></span>
            <span>追加質問に答えてみましょう。</span>
          `;
          this.startAnsweringTurn();
        });
      } else {
        // 音声データが万一取得できなかった場合も固定質問へ戻さず、生成された動的質問をブラウザ音声で確実に読み上げ
        this.speakText(this.currentFollowUpQuestion, () => {
          this.interviewerStatus.innerHTML = `
            <span class="w-2 h-2 rounded-full bg-secondary"></span>
            <span>追加質問に答えてみましょう。</span>
          `;
          this.startAnsweringTurn();
        });
      }

    } catch (err) {
      console.warn("動的追加質問APIエラー、AI実践モードを維持して進行します:", err);
      // 固定質問にすり替えず、回答を深掘りする自然な追加質問を動的にセットしてブラウザ音声で発話
      const fallbackList = this.currentQuestion?.followUpQuestions || [];
      const fallbackQ = fallbackList[0] || "具体的に、その時どのような工夫をしましたか？もっと詳しく教えてください。";
      this.currentFollowUpQuestion = fallbackQ;
      this.addChatMessage("interviewer", this.currentFollowUpQuestion, { isFollowUp: true });
      this.interviewerStatus.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-tertiary"></span>
        <span>追加質問を読み上げています…</span>
      `;
      this.speakText(this.currentFollowUpQuestion, () => {
        this.interviewerStatus.innerHTML = `
          <span class="w-2 h-2 rounded-full bg-secondary"></span>
          <span>追加質問に答えてみましょう。</span>
        `;
        this.startAnsweringTurn();
      });
    }
  }

  async finishCurrentQuestion(finalAnswer, currentBlob = null) {
    this.stopTimer();

    let initialAns = this.isFollowUp ? this.initialAnswer : finalAnswer;
    let followUpAns = this.isFollowUp ? finalAnswer : "";
    const targetAudioBlob = currentBlob || this.recordedAudioBlob || this.initialAudioBlob;

    if (this.candidateStatus) {
      this.candidateStatus.innerText = "🤖 AIが面接内容と音声を総合判定しています…";
    }

    const feedback = await this.evaluateAnswerWithGemini(
      this.currentQuestion,
      targetAudioBlob,
      finalAnswer,
      initialAns,
      followUpAns
    );

    // 音声認識が空またはフォールバックプレースホルダーの場合、Geminiの文字起こし結果で自動補正
    if (feedback && feedback.transcript) {
      const isPlaceholder = (txt) => !txt || txt.includes("音声回答") || txt.includes("音声を録音");
      if (this.isFollowUp) {
        if (isPlaceholder(followUpAns)) {
          followUpAns = feedback.transcript;
          this.updateLastCandidateMessage(feedback.transcript);
        }
      } else {
        if (isPlaceholder(initialAns)) {
          initialAns = feedback.transcript;
          this.updateLastCandidateMessage(feedback.transcript);
        }
      }
    }

    this.sessionAnswers.push({
      question: this.currentQuestion,
      initialAnswer: initialAns,
      followUpQuestion: this.currentFollowUpQuestion,
      followUpAnswer: followUpAns,
      feedback: feedback,
      elapsedSeconds: this.elapsedSeconds
    });

    if (this.currentMode === "practice" || this.currentMode === "ai-voice") {
      this.showInstantFeedbackModal(feedback, initialAns, followUpAns);
    } else {
      setTimeout(() => this.nextQuestion(), 500);
    }
  }

  showInstantFeedbackModal(feedback, initialAns = "", followUpAns = "") {
    const userName = this.currentUsername || "受検生";
    const userInitial = userName.charAt(0) || "受";
    const qText = this.currentQuestion ? this.currentQuestion.question : "";
    const followUpQ = this.currentFollowUpQuestion || "";

    this.modalFeedbackContent.innerHTML = `
      <div class="space-y-2">
        <!-- 最終結果画面と同一のやり取り履歴（吹き出しタイムライン） -->
        <div class="p-2 sm:p-2.5 bg-surface-container-low rounded-xl space-y-1.5 border border-surface-variant/30 text-left">
          <!-- 1. 先生の質問 -->
          <div class="flex items-start gap-1.5 max-w-[95%]">
            <div class="w-5 h-5 rounded-full bg-primary-container text-on-primary flex items-center justify-center font-bold text-[9px] flex-shrink-0 mt-0.5 shadow-xs">先</div>
            <div class="space-y-0.5">
              <span class="text-[9px] font-bold text-primary">先生の質問</span>
              <div class="p-2 rounded-xl rounded-tl-none bg-surface-container-lowest text-on-surface shadow-xs border border-surface-container text-xs leading-relaxed whitespace-pre-wrap">「${qText.trim()}」</div>
            </div>
          </div>

          <!-- 2. 受検生の回答 -->
          <div class="flex items-start gap-1.5 max-w-[95%] ml-auto flex-row-reverse">
            <div class="w-5 h-5 rounded-full bg-secondary-fixed text-on-secondary-fixed-variant flex items-center justify-center font-bold text-[9px] flex-shrink-0 mt-0.5 shadow-xs">${userInitial}</div>
            <div class="space-y-0.5 text-right">
              <span class="text-[9px] font-bold text-secondary">${userName}さんの回答</span>
              <div class="p-2 rounded-xl rounded-tr-none bg-secondary-container text-on-secondary-container shadow-xs border border-secondary/20 text-xs text-left leading-relaxed whitespace-pre-wrap">「${(initialAns || "（無回答）").trim()}」</div>
            </div>
          </div>

          <!-- 3. 追加質問＆追加回答（存在する場合） -->
          ${followUpQ ? `
            <div class="pt-1.5 border-t border-surface-variant/30 space-y-1.5">
              <div class="flex items-start gap-1.5 max-w-[95%]">
                <div class="w-5 h-5 rounded-full bg-tertiary-fixed text-on-tertiary-fixed-variant flex items-center justify-center font-bold text-[9px] flex-shrink-0 mt-0.5 shadow-xs">追</div>
                <div class="space-y-0.5">
                  <span class="text-[9px] font-bold text-tertiary">追加質問</span>
                  <div class="p-2 rounded-xl rounded-tl-none bg-amber-50/60 text-on-surface shadow-xs border border-tertiary/30 text-xs leading-relaxed whitespace-pre-wrap">「${followUpQ.trim()}」</div>
                </div>
              </div>

              <div class="flex items-start gap-1.5 max-w-[95%] ml-auto flex-row-reverse">
                <div class="w-5 h-5 rounded-full bg-secondary-fixed text-on-secondary-fixed-variant flex items-center justify-center font-bold text-[9px] flex-shrink-0 mt-0.5 shadow-xs">${userInitial}</div>
                <div class="space-y-0.5 text-right">
                  <span class="text-[9px] font-bold text-secondary">${userName}さんの追加回答</span>
                  <div class="p-2 rounded-xl rounded-tr-none bg-secondary-container text-on-secondary-container shadow-xs border border-secondary/20 text-xs text-left leading-relaxed whitespace-pre-wrap">「${(followUpAns || "（無回答）").trim()}」</div>
                </div>
              </div>
            </div>
          ` : ""}
        </div>

        <div class="p-2 sm:p-2.5 rounded-xl bg-secondary-fixed/40 border border-secondary/30">
          <h4 class="font-bold text-secondary text-[11px] mb-0.5">良かった点</h4>
          <p class="text-xs text-on-surface leading-snug whitespace-pre-wrap">${feedback.goodPoint}</p>
        </div>
        <div class="p-2 sm:p-2.5 rounded-xl bg-tertiary-container/20 border border-tertiary/30">
          <h4 class="font-bold text-tertiary text-[11px] mb-0.5">もっと良くなるアドバイス</h4>
          <p class="text-xs text-on-surface leading-snug whitespace-pre-wrap">${feedback.advice}</p>
        </div>
        ${feedback.mannerFeedback ? `
        <div class="p-2 sm:p-2.5 rounded-xl bg-primary-fixed/20 border border-primary/20">
          <h4 class="font-bold text-primary text-[11px] mb-0.5">話し方のポイント（音声分析）</h4>
          <p class="text-xs text-on-surface leading-snug whitespace-pre-wrap">${feedback.mannerFeedback}</p>
        </div>
        ` : ""}
        <div class="grid grid-cols-3 gap-1 text-center text-caption pt-0.5">
          <div class="p-1 rounded-lg bg-surface-container">
            <p class="text-outline text-[9px]">結論ファースト</p>
            <p class="font-bold text-primary text-xs">${feedback.isConclusionFirst ? "⭕ できてる" : "🔺 意識しよう"}</p>
          </div>
          <div class="p-1 rounded-lg bg-surface-container">
            <p class="text-outline text-[9px]">キーワード</p>
            <p class="font-bold text-secondary text-xs">${feedback.matchedKeywords && feedback.matchedKeywords.length > 0 ? "⭕バッチリ" : "🔺もう少し"}</p>
          </div>
          <div class="p-1 rounded-lg bg-surface-container">
            <p class="text-outline text-[9px]">ボリューム</p>
            <p class="font-bold text-primary text-xs">${feedback.volumeCheck}</p>
          </div>
        </div>
      </div>
    `;

    // 最後の質問なら「面接結果を見る」、それ以外は「次の質問へ進む」
    const isLast = (this.currentQuestionIndex + 1 >= this.questionList.length);
    this.btnModalNext.innerText = isLast ? "面接結果を見る" : "次の質問へ進む";

    this.feedbackModal.classList.remove("hidden");
    this.btnModalNext.onclick = () => {
      // iOS Safari アンロック：タップの同期コンテキストで即座にAudioContextを覚醒
      this.initAudioContext();
      if (this.audioCtx) {
        if (this.audioCtx.state === "suspended") {
          try { this.audioCtx.resume(); } catch(e) {}
        }
        try {
          // 無音バッファを再生してiOSオーディオ排他ロックを完全解除
          const dummy = this.audioCtx.createBuffer(1, 1, 22050);
          const src = this.audioCtx.createBufferSource();
          src.buffer = dummy;
          src.connect(this.audioCtx.destination);
          src.start(0);
        } catch(e) {}
      }

      if (navigator.audioSession) {
        try { navigator.audioSession.type = "playback"; } catch(e) {}
      }

      this.feedbackModal.classList.add("hidden");
      this.nextQuestion();
    };
  }

  nextQuestion() {
    this.currentQuestionIndex++;
    if (this.currentQuestionIndex < this.questionList.length) {
      this.loadQuestion();
    } else {
      this.showResultScreen();
    }
  }

  // --- Gemini API による音声・文脈の直接評価 ---
  async evaluateAnswerWithGemini(q, audioBlob, userText, initialAns, followUpAns) {
    try {
      let audioBase64 = null;
      let mimeType = null;
      if (audioBlob && audioBlob.size > 0) {
        audioBase64 = await this.blobToBase64(audioBlob);
        mimeType = audioBlob.type || 'audio/webm';
      }

      const combinedText = [initialAns, followUpAns, userText].filter(Boolean).join(" ");

      const response = await fetch('/api/evaluate-audio', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken || ''}`
        },
        body: JSON.stringify({
          audio: audioBase64,
          mimeType: mimeType,
          question: q,
          userText: combinedText
        })
      });

      if (response.status === 401) {
        alert("ログインが必要です。もう一度ログインしてください。");
        this.handleLogout();
        this.showLoginModal();
        return this.evaluateAnswerLocal(q, initialAns, followUpAns || userText);
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (data.success && data.evaluation) {
        const ev = data.evaluation;
        return {
          isConclusionFirst: ev.isConclusionFirst,
          matchedKeywords: ev.matchedKeywords || [],
          volumeCheck: ev.volumeEvaluation || "ちょうど良い",
          goodPoint: ev.goodPoint || "落ち着いて自分の言葉で回答できました。",
          advice: ev.advice || "この調子で練習を続けましょう！",
          mannerFeedback: ev.mannerFeedback || "",
          charCount: ev.transcript ? ev.transcript.length : combinedText.length,
          transcript: ev.transcript || combinedText
        };
      } else {
        throw new Error(data.error || "Evaluation failed");
      }
    } catch (err) {
      console.warn("Gemini evaluation fallback to local rules:", err);
      // ネットワークやAPI障害時はローカルのルールベース評価でフォールバック
      return this.evaluateAnswerLocal(q, initialAns, followUpAns || userText);
    }
  }

  // --- ローカル・ルールベース評価（フォールバック用） ---
  evaluateAnswerLocal(q, answer, followUpAnswer) {
    const text = (answer + " " + followUpAnswer).trim();
    const length = text.length;

    // 1. 結論ファーストチェック (冒頭部分の判定)
    const startChunk = text.slice(0, 45);
    const conclusionPatterns = [/からです/, /です/, /ます/, /理由は/, /私の長所は/, /やり遂げたことは/, /将来は/];
    const isConclusionFirst = conclusionPatterns.some(p => p.test(startChunk));

    // 2. キーワードマッチング
    const matchedKeywords = (q.keywords || []).filter(kw => text.includes(kw));

    // 3. ボリューム判定
    let volumeCheck = "ちょうど良い";
    if (length < 40) volumeCheck = "短め";
    if (length > 250) volumeCheck = "長め";

    // 4. アドバイス生成
    let goodPoint = "落ち着いて自分の言葉で回答できました。";
    if (matchedKeywords.length >= 2) {
      goodPoint += `「${matchedKeywords.join("」「")}」などの大切な視点が入っています！`;
    } else if (isConclusionFirst) {
      goodPoint += "最初に結論をはっきり言えていて、面接官に伝わりやすい構成です。";
    }

    let advice = "";
    if (!isConclusionFirst) {
      advice += "「〜だからです」「私の考えは〜です」と、まず最初に一番言いたい結論を言うとグッと引き締まります。";
    } else if (matchedKeywords.length === 0) {
      advice += `具体例として、${(q.intent || "").slice(0, 30)}…といった工夫や経験を添えるとさらに説得力が増しますよ。`;
    } else {
      advice += "この調子です！本番でも目を見てハキハキと、笑顔で伝えてみてください。";
    }

    return {
      isConclusionFirst,
      matchedKeywords,
      volumeCheck,
      goodPoint,
      advice,
      mannerFeedback: "",
      charCount: length
    };
  }

  // --- 結果画面表示 ---
  async showResultScreen() {
    this.setInputAcceptance(false);
    this.stopRecognitionCompletely();
    this.stopTimer();
    this.showView("result");

    const resultSummary = document.getElementById("result-summary");
    const resultList = document.getElementById("result-list");

    const totalQuestions = this.sessionAnswers.length;
    const conclusionCount = this.sessionAnswers.filter(a => a.feedback.isConclusionFirst).length;
    const userName = this.currentUsername || "受検生";
    const userInitial = userName.charAt(0) || "受";

    resultSummary.innerHTML = `
      <div class="space-y-3">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
          <div class="p-3.5 sm:p-4 rounded-xl bg-surface-container-lowest shadow-sm border border-surface-container text-center">
            <p class="text-xs text-on-surface-variant font-medium">回答設問数</p>
            <p class="text-xl sm:text-2xl font-bold text-primary mt-0.5">${totalQuestions} <span class="text-xs">問</span></p>
          </div>
          <div class="p-3.5 sm:p-4 rounded-xl bg-surface-container-lowest shadow-sm border border-surface-container text-center">
            <p class="text-xs text-on-surface-variant font-medium">結論ファースト率</p>
            <p class="text-xl sm:text-2xl font-bold text-secondary mt-0.5">${Math.round((conclusionCount / (totalQuestions || 1)) * 100)} <span class="text-xs">%</span></p>
          </div>
          <div class="p-3.5 sm:p-4 rounded-xl bg-surface-container-lowest shadow-sm border border-surface-container text-center">
            <p class="text-xs text-on-surface-variant font-medium">受検者</p>
            <p class="text-base sm:text-lg font-bold text-primary mt-1">${userName}さん</p>
          </div>
        </div>

        <!-- 面接全体の総合講評コンテナ（非同期ローディング） -->
        <div id="overall-report-container" class="p-4 sm:p-5 rounded-2xl bg-gradient-to-br from-primary-container/10 via-surface-container-low to-secondary/10 border border-primary/20 shadow-xs space-y-3">
          <div class="flex items-center gap-2 text-primary font-bold text-xs sm:text-sm">
            <span class="material-symbols-outlined text-[20px] animate-spin text-secondary">sync</span>
            <span>面接官が3問全体の総合講評・詳細アドバイスを作成中…</span>
          </div>
          <p class="text-[11px] text-on-surface-variant">あなたの回答内容と話し方を総合的に分析しています。少々お待ちください。</p>
        </div>
      </div>
    `;

    resultList.innerHTML = this.sessionAnswers.map((item, idx) => `
      <div id="result-card-${idx}" class="bg-surface-container-lowest rounded-2xl p-4 sm:p-5 shadow-sm border border-surface-container space-y-3">
        <!-- 設問ヘッダー -->
        <div class="flex items-center justify-between border-b border-surface-container pb-2">
          <span class="px-2.5 py-0.5 rounded-full bg-secondary-fixed text-on-secondary-fixed-variant text-[11px] font-bold">
            第 ${idx + 1} 問: ${item.question.category}
          </span>
          <span class="text-[11px] text-on-surface-variant flex items-center gap-1 font-medium">
            <span class="material-symbols-outlined text-[14px]">timer</span>
            ${item.elapsedSeconds}秒
          </span>
        </div>

        <!-- LINE風 やり取り履歴タイムライン -->
        <div class="p-3 bg-surface-container-low rounded-xl space-y-2 border border-surface-variant/30">
          <!-- 1. 先生の質問 -->
          <div class="flex items-start gap-2 max-w-[95%]">
            <div class="w-6 h-6 rounded-full bg-primary-container text-on-primary flex items-center justify-center font-bold text-[10px] flex-shrink-0 mt-0.5 shadow-xs">先</div>
            <div class="space-y-0.5">
              <span class="text-[10px] font-bold text-primary">先生の質問</span>
              <div class="p-2.5 rounded-xl rounded-tl-none bg-surface-container-lowest text-on-surface shadow-xs border border-surface-container text-xs sm:text-sm leading-relaxed whitespace-pre-wrap">「${item.question.question.trim()}」</div>
            </div>
          </div>

          <!-- 2. 受検生の回答 -->
          <div class="flex items-start gap-2 max-w-[95%] ml-auto flex-row-reverse">
            <div class="w-6 h-6 rounded-full bg-secondary-fixed text-on-secondary-fixed-variant flex items-center justify-center font-bold text-[10px] flex-shrink-0 mt-0.5 shadow-xs">${userInitial}</div>
            <div class="space-y-0.5 text-right">
              <span class="text-[10px] font-bold text-secondary">${userName}さんの回答</span>
              <div class="p-2.5 rounded-xl rounded-tr-none bg-secondary-container text-on-secondary-container shadow-xs border border-secondary/20 text-xs sm:text-sm text-left leading-relaxed whitespace-pre-wrap">「${(item.initialAnswer || "（無回答）").trim()}」</div>
            </div>
          </div>

          <!-- 3. 追加質問＆回答（あれば） -->
          ${item.followUpQuestion ? `
            <div class="pt-2 border-t border-surface-variant/30 space-y-2">
              <div class="flex items-start gap-2 max-w-[95%]">
                <div class="w-6 h-6 rounded-full bg-tertiary-fixed text-on-tertiary-fixed-variant flex items-center justify-center font-bold text-[10px] flex-shrink-0 mt-0.5 shadow-xs">追</div>
                <div class="space-y-0.5">
                  <span class="text-[10px] font-bold text-tertiary">追加質問</span>
                  <div class="p-2.5 rounded-xl rounded-tl-none bg-amber-50/60 text-on-surface shadow-xs border border-tertiary/30 text-xs sm:text-sm leading-relaxed whitespace-pre-wrap">「${item.followUpQuestion.trim()}」</div>
                </div>
              </div>

              <div class="flex items-start gap-2 max-w-[95%] ml-auto flex-row-reverse">
                <div class="w-6 h-6 rounded-full bg-secondary-fixed text-on-secondary-fixed-variant flex items-center justify-center font-bold text-[10px] flex-shrink-0 mt-0.5 shadow-xs">${userInitial}</div>
                <div class="space-y-0.5 text-right">
                  <span class="text-[10px] font-bold text-secondary">${userName}さんの追加回答</span>
                  <div class="p-2.5 rounded-xl rounded-tr-none bg-secondary-container text-on-secondary-container shadow-xs border border-secondary/20 text-xs sm:text-sm text-left leading-relaxed whitespace-pre-wrap">「${(item.followUpAnswer || "（無回答）").trim()}」</div>
                </div>
              </div>
            </div>
          ` : ""}
        </div>

        <!-- 評価＆アドバイス -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs pt-1">
          <div class="p-2.5 bg-secondary-fixed/20 rounded-xl text-on-secondary-fixed-variant border border-secondary/20">
            <p class="font-bold mb-0.5 flex items-center gap-1 text-[11px] sm:text-xs">
              <span class="text-secondary font-bold">✔</span> 良かった点
            </p>
            <p class="leading-snug">${item.feedback.goodPoint}</p>
          </div>
          <div class="p-2.5 bg-tertiary-container/20 rounded-xl text-on-tertiary-container border border-tertiary/20">
            <p class="font-bold mb-0.5 flex items-center gap-1 text-[11px] sm:text-xs">
              <span class="text-tertiary font-bold">💡</span> 次へのアドバイス
            </p>
            <p class="leading-snug">${item.feedback.advice}</p>
          </div>
        </div>

        ${item.feedback.mannerFeedback ? `
        <div class="p-2.5 bg-primary-fixed/20 rounded-xl text-on-primary-fixed-variant border border-primary/20 text-xs">
          <p class="font-bold mb-0.5 flex items-center gap-1 text-[11px] sm:text-xs">
            <span class="text-primary font-bold">🎙</span> 話し方のポイント
          </p>
          <p class="leading-snug text-on-surface">${item.feedback.mannerFeedback}</p>
        </div>
        ` : ""}

        <!-- 詳細具体例コンテナ（AI総合レポート取得後に挿入） -->
        <div id="deep-advice-container-${idx}" class="hidden pt-1"></div>
      </div>
    `).join("");

    // 面接全体の詳細振り返りレポートを非同期取得
    this.loadOverallFeedbackReport();
  }

  async loadOverallFeedbackReport() {
    const container = document.getElementById("overall-report-container");
    if (!container || this.sessionAnswers.length === 0) return;

    try {
      const response = await fetch("/api/overall-feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.authToken || ""}`
        },
        body: JSON.stringify({
          sessionAnswers: this.sessionAnswers
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (!data.success || !data.report) {
        throw new Error(data.error || "Report generation failed");
      }

      const report = data.report;
      const goodPoints = report.goodPointsDetail || report.overallReview || "";
      const improvement = report.improvementAdviceDetail || "";
      const manner = report.mannerAdviceDetail || report.overallMannerAdvice || "";

      // 1. 上部の総合講評カードを3つの充実したカードで更新
      container.innerHTML = `
        <div class="space-y-3">
          <div class="flex items-center gap-2 text-primary font-bold text-sm sm:text-base border-b border-primary/15 pb-2">
            <span class="material-symbols-outlined text-[20px] text-secondary">workspace_premium</span>
            <span>面接官からの総合講評・詳細アドバイス</span>
          </div>

          <!-- 1. 良かった点（実際の回答を引用して評価） -->
          ${goodPoints ? `
          <div class="p-3.5 sm:p-4 rounded-xl bg-secondary-fixed/30 border border-secondary/30 shadow-xs space-y-1.5">
            <h5 class="text-xs sm:text-sm font-bold text-secondary flex items-center gap-1.5">
              <span class="material-symbols-outlined text-[17px]">verified</span>
              <span>良かった点（具体的評価）</span>
            </h5>
            <p class="text-xs sm:text-sm text-on-surface leading-relaxed whitespace-pre-wrap">${goodPoints}</p>
          </div>
          ` : ""}

          <!-- 2. もっと良くなる改善案（ビフォー・アフター具体例） -->
          ${improvement ? `
          <div class="p-3.5 sm:p-4 rounded-xl bg-amber-50/80 border border-amber-200/90 shadow-xs space-y-1.5">
            <h5 class="text-xs sm:text-sm font-bold text-tertiary flex items-center gap-1.5">
              <span class="material-symbols-outlined text-[17px]">tips_and_updates</span>
              <span>もっと良くなる改善案（ビフォー・アフター具体例）</span>
            </h5>
            <p class="text-xs sm:text-sm text-on-surface leading-relaxed whitespace-pre-wrap">${improvement}</p>
          </div>
          ` : ""}

          <!-- 3. 話し方のアドバイス（全体のトーン ＆ 設問別改善） -->
          ${manner ? `
          <div class="p-3.5 sm:p-4 rounded-xl bg-primary-fixed/20 border border-primary/25 shadow-xs space-y-1.5">
            <h5 class="text-xs sm:text-sm font-bold text-primary flex items-center gap-1.5">
              <span class="material-symbols-outlined text-[17px]">record_voice_over</span>
              <span>話し方のアドバイス（全体＆設問別アドバイス）</span>
            </h5>
            <p class="text-xs sm:text-sm text-on-surface leading-relaxed whitespace-pre-wrap">${manner}</p>
          </div>
          ` : ""}
        </div>
      `;

      // 2. 各設問カードに「詳しい深掘りアドバイス＆改善具体例」を追加
      if (Array.isArray(report.questionDetails)) {
        report.questionDetails.forEach((detail, idx) => {
          const detailContainer = document.getElementById(`deep-advice-container-${idx}`);
          if (detailContainer && (detail.deepAdvice || detail.concreteExample)) {
            detailContainer.className = "pt-2 border-t border-surface-container space-y-2";
            detailContainer.innerHTML = `
              <div class="p-3 rounded-xl bg-amber-50/70 border border-amber-200/80 space-y-1.5 text-xs">
                <p class="font-bold text-tertiary flex items-center gap-1 text-[11px] sm:text-xs">
                  <span class="material-symbols-outlined text-[15px]">auto_stories</span>
                  <span>面接官の深掘り解説と具体例</span>
                </p>
                ${detail.deepAdvice ? `<p class="text-on-surface leading-relaxed text-xs">${detail.deepAdvice}</p>` : ""}
                ${detail.concreteExample ? `
                <div class="p-2.5 rounded-lg bg-surface-container-lowest border border-amber-200/60 mt-1">
                  <span class="text-[10px] font-bold text-secondary block mb-0.5">🌟 おすすめの回答例・フレーズ</span>
                  <p class="text-on-surface-variant leading-relaxed text-xs">「${detail.concreteExample}」</p>
                </div>
                ` : ""}
              </div>
            `;
          }
        });
      }
    } catch (err) {
      console.warn("総合レポート取得エラー:", err);
      container.innerHTML = `
        <div class="flex items-center gap-2 text-primary font-bold text-xs sm:text-sm">
          <span class="material-symbols-outlined text-[18px] text-tertiary">info</span>
          <span>各設問のアドバイスを振り返り、本番に向けて復習してみましょう！</span>
        </div>
      `;
    }
  }

  // --- お助けフレーズの処理 ---
  handleRescue(type) {
    const text = RESCUE_RESPONSES[type];
    if (!text) return;

    this.stopAllAudio();
    this.setInputAcceptance(false);

    // タイムラインにお助けフレーズと返答を記録
    let rescueLabel = "";
    if (type === "repeat") rescueLabel = "「もう一度お願いします」とお伝えしました";
    if (type === "think") rescueLabel = "「少し考える時間をください」とお伝えしました";
    if (type === "restart") rescueLabel = "「最初からやり直します」とお伝えしました";
    this.addSystemDivider(rescueLabel);
    this.addChatMessage("interviewer", text, { isFollowUp: true });

    if (type === "repeat") {
      if (this.isFollowUp && this.currentFollowUpAudioFile) {
        this.interviewerStatus.innerHTML = `
          <span class="w-2 h-2 rounded-full bg-tertiary"></span>
          <span>追加質問を読み上げています…</span>
        `;
        this.playAudioFile(this.currentFollowUpAudioFile, () => {
          this.interviewerStatus.innerHTML = `
            <span class="w-2 h-2 rounded-full bg-secondary"></span>
            <span>追加質問に答えてみましょう。</span>
          `;
          this.startAnsweringTurn();
        });
      } else if (this.currentQuestion) {
        this.interviewerStatus.innerHTML = `
          <span class="w-2 h-2 rounded-full bg-secondary"></span>
          <span>質問を読み上げ中…</span>
        `;
        this.playQuestionAudio(this.currentQuestion.id, () => {
          this.interviewerStatus.innerHTML = `
            <span class="w-2 h-2 rounded-full bg-secondary"></span>
            <span>あなたの番です。</span>
          `;
          this.startAnsweringTurn();
        });
      }
    } else if (type === "think") {
      this.interviewerStatus.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-secondary"></span>
        <span>準備ができたら話してください（お待ちしています）</span>
      `;
      this.startAnsweringTurn();
    } else if (type === "restart") {
      this.resetInputArea();
      this.interviewerStatus.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-secondary"></span>
        <span>深呼吸して、最初からどうぞ。</span>
      `;
      this.startAnsweringTurn();
    }
  }

  // --- 録音音声ファイルのパス取得 ---
  getVoiceFilePath(questionId) {
    if (!questionId) return null;
    const num = parseInt(questionId.replace("Q", ""), 10);
    if (isNaN(num)) return null;
    const pad = String(num).padStart(3, "0");
    return `VOICE/${pad}_question(Coral Reef Guide 1).wav`;
  }

  // --- 録音音声（本質問）の再生制御 ---
  playQuestionAudio(questionId, onEndCallback = null) {
    const audioPath = this.getVoiceFilePath(questionId);
    this.playAudioFile(audioPath, onEndCallback);
  }

  // --- 音声ファイルの再生制御（Web Audio API 主軸 / HTMLAudio フォールバック） ---
  async playAudioFile(audioPath, onEndCallback = null) {
    this.stopAllAudio();
    this.stopRecognitionCompletely(); // 先生の発話中はマイクを完全に切る
    this.isSpeaking = true;
    this.setInputAcceptance(false);

    if (navigator.audioSession) {
      try {
        navigator.audioSession.type = "playback";
      } catch(e) {}
    }

    if (!audioPath) {
      this.isSpeaking = false;
      if (onEndCallback) onEndCallback();
      return;
    }

    await this.initAudioContext();

    // 1. Web Audio API が使用可能な場合は AudioContext で再生（iOSオーディオ排他ロック競合を完全回避）
    if (this.audioCtx) {
      try {
        if (this.audioCtx.state !== "running") {
          try { await this.audioCtx.resume(); } catch(e) {}
        }

        const buffer = await this.loadAudioBuffer(audioPath);
        if (buffer && this.isSpeaking) {
          // 音量自動ノーマライズとコンプレッサー接続
          const normGain = this.calculateNormalizeGain(buffer, 0.85);
          const gainNode = this.audioCtx.createGain();
          gainNode.gain.setValueAtTime(normGain, this.audioCtx.currentTime);

          const source = this.audioCtx.createBufferSource();
          source.buffer = buffer;
          source.connect(gainNode);
          gainNode.connect(this.compressor || this.audioCtx.destination);
          this.currentAudioSource = source;

          let hasFinished = false;
          let safetyTimer = null;
          const finish = () => {
            if (hasFinished) return;
            hasFinished = true;
            if (safetyTimer) clearTimeout(safetyTimer);
            this.isSpeaking = false;
            this.currentAudioSource = null;
            if (onEndCallback) onEndCallback();
          };

          // セーフティガード：音声長＋1.5秒（または最大10秒）で確実に回答ターンへ移行しフリーズを物理的に防止
          const maxDuration = Math.max(2, (buffer.duration || 6) + 1.5) * 1000;
          safetyTimer = setTimeout(finish, maxDuration);

          source.onended = finish;
          source.start(0);
          return;
        }
      } catch (err) {
        console.warn("Web Audio API 再生エラー、フォールバックを試みます:", err);
      }
    }

    // 2. フォールバック（HTMLAudioElement）
    try {
      const audio = new Audio(audioPath);
      this.currentAudio = audio;

      let hasFinished = false;
      let safetyTimer = null;
      const finish = () => {
        if (hasFinished) return;
        hasFinished = true;
        if (safetyTimer) clearTimeout(safetyTimer);
        this.isSpeaking = false;
        if (this.currentAudio) {
          try {
            this.currentAudio.pause();
            this.currentAudio.src = "";
          } catch(e) {}
          this.currentAudio = null;
        }
        if (onEndCallback) onEndCallback();
      };

      // セーフティガード（最大10秒）
      safetyTimer = setTimeout(finish, 10000);

      audio.onended = finish;
      audio.onerror = (e) => {
        if (safetyTimer) clearTimeout(safetyTimer);
        console.warn("音声ファイルの読み込み/再生エラー、ブラウザ音声で読み上げます:", audioPath, e);
        this.fallbackToSpeech(onEndCallback);
      };

      await audio.play();
      return;
    } catch (e) {
      console.warn("HTMLAudio 自動再生エラー、ブラウザ音声で読み上げます:", e);
      this.fallbackToSpeech(onEndCallback);
    }
  }

  // 音声ファイル再生失敗時の確実なブラウザ音声読み上げフォールバック
  fallbackToSpeech(onEndCallback = null) {
    if (this.currentQuestion && this.currentQuestion.question) {
      this.speakText(this.currentQuestion.question, onEndCallback);
    } else if (onEndCallback) {
      this.isSpeaking = false;
      onEndCallback();
    }
  }

  // --- Base64 音声（Gemini TTS Kore 生成WAV）の再生制御 ---
  async playBase64Audio(base64Data, mimeType = "audio/wav", onEndCallback = null) {
    this.stopAllAudio();
    this.stopRecognitionCompletely(); // 先生の発話中はマイクを完全に切る
    this.isSpeaking = true;
    this.setInputAcceptance(false);

    if (navigator.audioSession) {
      try {
        navigator.audioSession.type = "playback";
      } catch(e) {}
    }

    if (!base64Data) {
      this.isSpeaking = false;
      if (onEndCallback) onEndCallback();
      return;
    }

    await this.initAudioContext();

    // 1. Web Audio API でデコードして再生
    if (this.audioCtx) {
      try {
        if (this.audioCtx.state !== "running") {
          try { await this.audioCtx.resume(); } catch(e) {}
        }

        const binaryStr = window.atob(base64Data);
        const len = binaryStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        // slice(0) で安全なコピーArrayBufferを作成
        const arrayBuffer = bytes.buffer.slice(0);

        const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
        if (!this.isSpeaking) return;

        // 音量自動ノーマライズとコンプレッサー接続
        const normGain = this.calculateNormalizeGain(audioBuffer, 0.85);
        const gainNode = this.audioCtx.createGain();
        gainNode.gain.setValueAtTime(normGain, this.audioCtx.currentTime);

        const source = this.audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(gainNode);
        gainNode.connect(this.compressor || this.audioCtx.destination);
        this.currentAudioSource = source;

        let hasFinished = false;
        let safetyTimer = null;
        const finish = () => {
          if (hasFinished) return;
          hasFinished = true;
          if (safetyTimer) clearTimeout(safetyTimer);
          this.isSpeaking = false;
          this.currentAudioSource = null;
          if (onEndCallback) onEndCallback();
        };

        const maxDuration = Math.max(2, (audioBuffer.duration || 6) + 1.5) * 1000;
        safetyTimer = setTimeout(finish, maxDuration);

        source.onended = finish;
        source.start(0);
        return;
      } catch (err) {
        console.warn("Base64 Web Audio API デコード失敗、フォールバック再生:", err);
      }
    }

    // 2. フォールバック（HTMLAudioElement）
    const audio = new Audio(`data:${mimeType};base64,${base64Data}`);
    this.currentAudio = audio;

    let hasFinished = false;
    let safetyTimer = null;
    const finish = () => {
      if (hasFinished) return;
      hasFinished = true;
      if (safetyTimer) clearTimeout(safetyTimer);
      this.isSpeaking = false;
      if (this.currentAudio) {
        try {
          this.currentAudio.pause();
          this.currentAudio.src = "";
        } catch(e) {}
        this.currentAudio = null;
      }
      if (onEndCallback) onEndCallback();
    };

    safetyTimer = setTimeout(finish, 10000);

    audio.onended = finish;
    audio.onerror = (e) => {
      if (safetyTimer) clearTimeout(safetyTimer);
      console.warn("Base64 音声再生エラー:", e);
      finish();
    };

    audio.play().catch(e => {
      if (safetyTimer) clearTimeout(safetyTimer);
      console.warn("Base64 音声自動再生エラー:", e);
      finish();
    });
  }

  // --- 全音声の停止 ---
  stopAllAudio() {
    if (this.currentAudioSource) {
      try {
        this.currentAudioSource.onended = null;
        this.currentAudioSource.stop();
      } catch(e) {}
      this.currentAudioSource = null;
    }
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
        this.currentAudio.src = ""; // iOSのオーディオセッションロックを解放
      } catch(e) {}
      this.currentAudio = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.isSpeaking = false;
  }

  pauseInputAndSpeak(text) {
    this.setInputAcceptance(false);
    this.startAnsweringTurn();
  }

  updateMicUI(active) {
    if (active) {
      this.candidateStatus.innerText = "Aさんの番です（マイク録音中）";
      this.voiceVisualizer.classList.remove("opacity-20");
      this.btnMic.classList.remove("bg-primary-container");
      this.btnMic.classList.add("bg-error", "animate-pulse");
    } else {
      this.candidateStatus.innerText = "Aさんの番です（待機中）";
      this.voiceVisualizer.classList.add("opacity-20");
      this.btnMic.classList.add("bg-primary-container");
      this.btnMic.classList.remove("bg-error", "animate-pulse");
    }
  }

  // --- 読み上げ用テキスト変換（「高志」「辛い」などの読み間違い防止） ---
  formatForSpeech(text) {
    if (!text) return "";
    return text
      .replace(/高志中等教育学校/g, "こうしちゅうとうきょういくがっこう")
      .replace(/高志中等/g, "こうしちゅうとう")
      .replace(/本校（高志中等）/g, "本校、こうしちゅうとう")
      .replace(/高志/g, "こうし")
      .replace(/辛い/g, "つらい")
      .replace(/辛かった/g, "つらかった")
      .replace(/辛く/g, "つらく")
      .replace(/辛さ/g, "つらさ")
      .replace(/辛けれ/g, "つらけれ");
  }

  async getVoicesAsync() {
    let voices = window.speechSynthesis.getVoices();
    if (voices && voices.length > 0) return voices;

    return new Promise((resolve) => {
      let resolved = false;
      const checkDone = () => {
        if (resolved) return;
        const currentVoices = window.speechSynthesis.getVoices();
        if (currentVoices && currentVoices.length > 0) {
          resolved = true;
          clearInterval(pollInterval);
          clearTimeout(timeoutId);
          resolve(currentVoices);
        }
      };

      window.speechSynthesis.onvoiceschanged = checkDone;
      const pollInterval = setInterval(checkDone, 50);

      // 最大1000ms待機
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          clearInterval(pollInterval);
          resolve(window.speechSynthesis.getVoices());
        }
      }, 1000);
    });
  }

  // --- 音声読み上げ（落ち着いた大人の男性声） ---
  async speakText(rawText, onEndCallback = null) {
    const speechText = this.formatForSpeech(rawText);
    this.isSpeaking = true;

    if (!('speechSynthesis' in window)) {
      this.isSpeaking = false;
      if (onEndCallback) onEndCallback();
      return;
    }

    // 既存の音声を即座に停止
    window.speechSynthesis.cancel();

    // 音声一覧のロードを確実に待機（初回1問目の女声化を完全防止）
    const voices = await this.getVoicesAsync();

    // 音声リスト取得後に Utterance を生成（事前生成によるデフォルト音声固定化を防止）
    const utterance = new SpeechSynthesisUtterance(speechText);
    utterance.lang = "ja-JP";
    utterance.rate = 0.92; // 落ち着いて聞き取りやすいスピード

    let selectedPitch = 0.72; // 基本は落ち着いた低音トーン

    if (voices && voices.length > 0) {
      // 1. 日本語の男性ボイスを優先探索（Ichiro, Keita, Kenji, Daichi, Takumi, Otoya, Hattori, Male, 男 など）
      const maleVoice = voices.find(v => 
        (v.lang.startsWith("ja") || v.lang === "ja-JP") && 
        (v.name.includes("Ichiro") || v.name.includes("Keita") || v.name.includes("Kenji") || v.name.includes("Daichi") || v.name.includes("Takumi") || v.name.includes("Otoya") || v.name.includes("Hattori") || v.name.includes("Male") || v.name.includes("男"))
      );

      // 2. 日本語ボイスのフォールバック
      const jaVoice = maleVoice || voices.find(v => v.lang === "ja-JP" || v.lang.startsWith("ja"));

      if (jaVoice) {
        utterance.voice = jaVoice;
        if (maleVoice) {
          selectedPitch = 0.85; // 男性の地声がある場合は自然なトーン
        } else {
          selectedPitch = 0.70; // 女性ボイス等の場合はピッチを下げて落ち着いた中低音に
        }
      }
    }

    utterance.pitch = selectedPitch;

    let hasEnded = false;
    const finish = () => {
      if (hasEnded) return;
      hasEnded = true;
      this.isSpeaking = false;
      if (onEndCallback) onEndCallback();
    };

    utterance.onend = finish;
    utterance.onerror = (e) => {
      console.warn("音声再生エラー:", e);
      finish();
    };

    // 音声再生を開始
    window.speechSynthesis.speak(utterance);
  }

  // --- タイマー操作 ---
  startTimer() {
    this.stopTimer();
    this.elapsedSeconds = 0;
    this.renderTimer();

    this.timerInterval = setInterval(() => {
      this.elapsedSeconds++;
      this.renderTimer();
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  renderTimer() {
    const min = String(Math.floor(this.elapsedSeconds / 60)).padStart(2, "0");
    const sec = String(this.elapsedSeconds % 60).padStart(2, "0");
    this.timerDisplay.innerText = `${min}:${sec}`;
  }

  // --- 認証関連処理 ---
  updateAuthUI() {
    if (this.authToken && this.currentUsername) {
      if (this.userDisplay) {
        this.userDisplay.innerText = `${this.currentUsername}さん`;
        this.userDisplay.classList.remove("hidden");
      }
      if (this.btnAuthAction) {
        this.btnAuthAction.innerText = "ログアウト";
        this.btnAuthAction.className = "text-[11px] sm:text-xs px-3 py-1 rounded-full bg-surface-container text-error font-bold hover:bg-error-container hover:text-on-error-container shadow-xs transition-all cursor-pointer border border-error/30";
      }
    } else {
      if (this.userDisplay) {
        this.userDisplay.innerText = "";
        this.userDisplay.classList.add("hidden");
      }
      if (this.btnAuthAction) {
        this.btnAuthAction.innerText = "ログイン";
        this.btnAuthAction.className = "text-[11px] sm:text-xs px-3 py-1 rounded-full bg-primary-container text-on-primary font-bold hover:opacity-90 shadow-xs transition-all cursor-pointer";
      }
    }
  }

  showLoginModal() {
    if (!this.loginModal) return;
    if (this.loginPassword) this.loginPassword.value = "";
    if (this.loginErrorMsg) {
      this.loginErrorMsg.innerText = "";
      this.loginErrorMsg.classList.add("hidden");
    }
    this.loginModal.classList.remove("hidden");
    setTimeout(() => {
      if (this.loginUsername && !this.loginUsername.value) {
        this.loginUsername.focus();
      } else if (this.loginPassword) {
        this.loginPassword.focus();
      }
    }, 100);
  }

  hideLoginModal() {
    if (!this.loginModal) return;
    this.loginModal.classList.add("hidden");
    if (this.loginErrorMsg) {
      this.loginErrorMsg.innerText = "";
      this.loginErrorMsg.classList.add("hidden");
    }
  }

  async handleLogin(e) {
    if (e) e.preventDefault();
    const username = this.loginUsername?.value.trim();
    const password = this.loginPassword?.value;
    if (!username || !password) {
      if (this.loginErrorMsg) {
        this.loginErrorMsg.innerText = "ユーザー名とパスワードを入力してください。";
        this.loginErrorMsg.classList.remove("hidden");
      }
      return;
    }

    const submitBtn = document.getElementById("btn-login-submit");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.add("opacity-60");
    }

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      }).catch(() => {
        throw new Error("サーバーと通信できませんでした。インターネット接続をご確認ください。");
      });

      let data = null;
      try {
        data = await res.json();
      } catch (jsonErr) {
        if (res.status === 404) {
          throw new Error("サーバーと通信できませんでした。インターネット接続をご確認ください。");
        }
        throw new Error("通信エラーが発生しました。もう一度お試しください。");
      }

      if (!res.ok) {
        if (res.status === 401) {
          throw new Error(data?.error || "ユーザー名またはパスワードが正しくありません。");
        }
        throw new Error(data?.error || "ログインに失敗しました。");
      }

      this.authToken = data.token;
      this.currentUsername = data.username;
      sessionStorage.setItem("koshi_auth_token", data.token);
      sessionStorage.setItem("koshi_auth_user", data.username);

      this.updateAuthUI();
      this.hideLoginModal();
    } catch (err) {
      if (this.loginErrorMsg) {
        this.loginErrorMsg.innerText = err.message || "ログインに失敗しました。";
        this.loginErrorMsg.classList.remove("hidden");
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.classList.remove("opacity-60");
      }
    }
  }

  handleLogout() {
    this.authToken = null;
    this.currentUsername = null;
    sessionStorage.removeItem("koshi_auth_token");
    sessionStorage.removeItem("koshi_auth_user");
    this.updateAuthUI();

    // 面接中の場合はホーム画面に戻す
    if (this.viewInterview && !this.viewInterview.classList.contains("hidden")) {
      this.stopAllAudio();
      this.stopTimer();
      this.setInputAcceptance(false);
      this.viewInterview.classList.add("hidden");
      if (this.viewResult) this.viewResult.classList.add("hidden");
      if (this.viewHome) this.viewHome.classList.remove("hidden");
    }
  }
}

// 初期化
window.addEventListener("DOMContentLoaded", () => {
  window.app = new InterviewApp();
});
