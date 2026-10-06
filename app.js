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
    this.isManuallyEdited = false;    // 手動編集中フラグ
    this.currentAudio = null;         // 録音音声再生用フォールバックインスタンス
    this.audioCtx = null;             // Web Audio API AudioContext
    this.audioBufferCache = new Map();// デコード済み音声バッファキャッシュ
    this.currentAudioSource = null;   // 現在再生中の AudioBufferSourceNode
    this.currentFollowUpAudioFile = null; // 現在の追加質問音声ファイルパス

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
    this.speechTranscript = document.getElementById("speech-transcript");
    this.charCount = document.getElementById("char-count");
    this.editBadge = document.getElementById("edit-badge");
    this.btnMic = document.getElementById("btn-mic");
    this.btnSubmit = document.getElementById("btn-submit");
    
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

  // --- Web Audio API 初期化（iOS User Gesture 内で呼び出してロック解除） ---
  initAudioContext() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
      }
    }
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      this.audioCtx.resume();
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

      // 手動編集された後は、音声認識による自動上書きを行わない
      if (this.isManuallyEdited) {
        return;
      }

      // 今回のターンの発話テキストを抽出
      let turnText = "";
      for (let i = 0; i < event.results.length; ++i) {
        turnText += event.results[i][0].transcript;
      }

      this.speechTranscript.value = turnText;
      this.charCount.innerText = `${turnText.length} 文字`;
    };

    rec.onerror = (event) => {
      console.warn("Speech recognition error:", event.error);
      if (event.error === "not-allowed") {
        alert("マイクの使用が許可されていません。ブラウザのアドレスバーからマイクを許可してください。");
      } else if (event.error !== "no-speech") {
        if (this.candidateStatus) {
          this.candidateStatus.innerText = `マイク状況: ${event.error}`;
        }
      }
    };

    rec.onend = () => {
      this.isRecognitionActive = false;
      // ユーザーが回答中（録音中）であれば自動復帰を試みる（iOSのセッション安定のためディレイ設定）
      if (this.isAcceptingInput && !this.isSpeaking && this.viewInterview && !this.viewInterview.classList.contains("hidden")) {
        setTimeout(() => {
          if (this.isAcceptingInput && !this.isSpeaking) {
            try {
              rec.start();
            } catch(e) {}
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
    
    // 再生ボタン
    this.btnReplay.addEventListener("click", () => {
      this.initAudioContext();
      if (this.isFollowUp) {
        if (this.currentFollowUpAudioFile) {
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
        this.isManuallyEdited = false;
        if (this.editBadge) this.editBadge.classList.add("hidden");
        this.setInputAcceptance(true);
        this.updateActionButton("recording");
      }
    });

    // 回答アクションボタン（1回目: タップして話す / 2回目: 送信）
    this.btnSubmit.addEventListener("click", () => this.handleActionClick());

    // テキストエリア直接入力イベント（手動編集の検知）
    this.speechTranscript.addEventListener("input", () => {
      this.isManuallyEdited = true;
      if (this.editBadge) this.editBadge.classList.remove("hidden");
      this.charCount.innerText = `${this.speechTranscript.value.length} 文字`;
    });

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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      this.mediaStream = stream;

      const mimeType = this.getSupportedAudioMimeType();
      const options = mimeType ? { mimeType } : {};
      const recorder = new MediaRecorder(stream, options);
      this.mediaRecorder = recorder;
      this.recordedMimeType = recorder.mimeType || mimeType || 'audio/webm';

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
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        if (this.mediaStream) {
          this.mediaStream.getTracks().forEach(t => t.stop());
          this.mediaStream = null;
        }
        resolve(this.recordedAudioBlob || null);
        return;
      }

      this.mediaRecorder.onstop = () => {
        const mime = this.recordedMimeType || 'audio/webm';
        const blob = new Blob(this.audioChunks, { type: mime });
        this.recordedAudioBlob = blob;
        if (this.mediaStream) {
          this.mediaStream.getTracks().forEach(t => t.stop());
          this.mediaStream = null;
        }
        this.mediaRecorder = null;
        resolve(blob);
      };

      try {
        this.mediaRecorder.stop();
      } catch (e) {
        console.warn("Error stopping MediaRecorder:", e);
        if (this.mediaStream) {
          this.mediaStream.getTracks().forEach(t => t.stop());
          this.mediaStream = null;
        }
        this.mediaRecorder = null;
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

  shuffle(array) {
    return array.sort(() => Math.random() - 0.5);
  }

  setupInterviewScreen() {
    this.showView("interview");
    if (this.currentMode === "practice") {
      this.modeBadge.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-secondary animate-pulse flex-shrink-0"></span>
        <span class="truncate">練習モード</span>
      `;
      this.practiceSidebar.classList.remove("hidden");
    } else {
      this.modeBadge.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-primary animate-pulse flex-shrink-0"></span>
        <span class="font-bold text-primary truncate">本番モード</span>
      `;
      this.practiceSidebar.classList.add("hidden");
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
    if (this.editBadge) this.editBadge.classList.add("hidden");
    if (this.speechTranscript) this.speechTranscript.value = "";
    if (this.charCount) this.charCount.innerText = "0 文字";
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
      this.btnSubmit.innerHTML = `
        <span>この内容で回答を送信する</span>
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
    this.setInputAcceptance(false);
    this.updateActionButton("analyzing");
    if (this.candidateStatus) {
      this.candidateStatus.innerText = "🤖 音声を分析しています…";
    }

    // 録音停止＆Blob取得
    const audioBlob = await this.stopRecordingAudio();
    const answerText = this.speechTranscript.value.trim();

    // タイムラインにAさんの発言を追加
    const displayText = answerText || "🎙（音声を録音・送信しました）";
    this.addChatMessage("candidate", displayText);

    // 追加質問（深掘り）の判定
    if (!this.isFollowUp && this.currentQuestion.followUpQuestions && this.currentQuestion.followUpQuestions.length > 0) {
      const shouldFollowUp = (this.currentMode === "exam") 
        ? (this.currentQuestion.priority === "S" || Math.random() > 0.4)
        : true;

      if (shouldFollowUp) {
        this.initialAudioBlob = audioBlob;
        this.triggerFollowUp(answerText || "（音声回答）");
        return;
      }
    }

    await this.finishCurrentQuestion(answerText, audioBlob);
  }

  // --- 追加質問の発動（※録音音声の再生） ---
  triggerFollowUp(initialAnswer) {
    this.isFollowUp = true;
    this.initialAnswer = initialAnswer;
    
    const followUps = this.currentQuestion.followUpQuestions;
    const randomIndex = Math.floor(Math.random() * followUps.length);
    this.currentFollowUpQuestion = followUps[randomIndex];

    const addNumStr = String(randomIndex + 1).padStart(2, "0");
    this.currentFollowUpAudioFile = `VOICE/${this.currentQuestion.id}_add${addNumStr}.wav`;

    this.resetInputArea();
    this.setInputAcceptance(false);
    this.updateActionButton("speaking");
    this.interviewerStatus.innerHTML = `
      <span class="w-2 h-2 rounded-full bg-tertiary"></span>
      <span>回答を確認しています…</span>
    `;

    // iOSマイク回路の完全解放（約500ms）を待ってから追加質問を開始
    setTimeout(() => {
      // タイムラインに追加質問をメッセージとして追加
      this.addChatMessage("interviewer", this.currentFollowUpQuestion, { isFollowUp: true });
      this.interviewerStatus.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-tertiary"></span>
        <span>追加質問を読み上げています…</span>
      `;

      // 音声ファイルを再生
      this.playAudioFile(this.currentFollowUpAudioFile, () => {
        this.interviewerStatus.innerHTML = `
          <span class="w-2 h-2 rounded-full bg-secondary"></span>
          <span>追加質問に答えてみましょう。</span>
        `;
        this.startAnsweringTurn();
      });
    }, 500);
  }

  async finishCurrentQuestion(finalAnswer, currentBlob = null) {
    this.stopTimer();

    const initialAns = this.isFollowUp ? this.initialAnswer : finalAnswer;
    const followUpAns = this.isFollowUp ? finalAnswer : "";
    const targetAudioBlob = currentBlob || this.recordedAudioBlob || this.initialAudioBlob;

    if (this.candidateStatus) {
      this.candidateStatus.innerText = "🤖 AIが面接内容と音声を総合判定しています…";
    }

    const feedback = await this.evaluateAnswerWithGemini(
      this.currentQuestion,
      targetAudioBlob,
      this.speechTranscript.value.trim(),
      initialAns,
      followUpAns
    );

    this.sessionAnswers.push({
      question: this.currentQuestion,
      initialAnswer: initialAns,
      followUpQuestion: this.currentFollowUpQuestion,
      followUpAnswer: followUpAns,
      feedback: feedback,
      elapsedSeconds: this.elapsedSeconds
    });

    if (this.currentMode === "practice") {
      this.showInstantFeedbackModal(feedback);
    } else {
      setTimeout(() => this.nextQuestion(), 500);
    }
  }

  showInstantFeedbackModal(feedback) {
    this.modalFeedbackContent.innerHTML = `
      <div class="space-y-2">
        <div class="p-2.5 sm:p-3 rounded-xl bg-secondary-fixed/40 border border-secondary/30">
          <h4 class="font-bold text-secondary text-[11px] sm:text-xs mb-0.5">良かった点</h4>
          <p class="text-xs sm:text-[13px] text-on-surface leading-snug whitespace-pre-wrap">${feedback.goodPoint}</p>
        </div>
        <div class="p-2.5 sm:p-3 rounded-xl bg-tertiary-container/20 border border-tertiary/30">
          <h4 class="font-bold text-tertiary text-[11px] sm:text-xs mb-0.5">もっと良くなるアドバイス</h4>
          <p class="text-xs sm:text-[13px] text-on-surface leading-snug whitespace-pre-wrap">${feedback.advice}</p>
        </div>
        ${feedback.mannerFeedback ? `
        <div class="p-2.5 sm:p-3 rounded-xl bg-primary-fixed/20 border border-primary/20">
          <h4 class="font-bold text-primary text-[11px] sm:text-xs mb-0.5">話し方のポイント（音声分析）</h4>
          <p class="text-xs sm:text-[13px] text-on-surface leading-snug whitespace-pre-wrap">${feedback.mannerFeedback}</p>
        </div>
        ` : ""}
        <div class="grid grid-cols-3 gap-1.5 text-center text-caption pt-0.5">
          <div class="p-1.5 rounded-lg bg-surface-container">
            <p class="text-outline text-[9px] sm:text-[10px]">結論ファースト</p>
            <p class="font-bold text-primary text-xs sm:text-sm">${feedback.isConclusionFirst ? "⭕ できてる" : "🔺 意識しよう"}</p>
          </div>
          <div class="p-1.5 rounded-lg bg-surface-container">
            <p class="text-outline text-[9px] sm:text-[10px]">キーワード</p>
            <p class="font-bold text-secondary text-xs sm:text-sm">${feedback.matchedKeywords && feedback.matchedKeywords.length > 0 ? "⭕バッチリ" : "🔺もう少し"}</p>
          </div>
          <div class="p-1.5 rounded-lg bg-surface-container">
            <p class="text-outline text-[9px] sm:text-[10px]">ボリューム</p>
            <p class="font-bold text-primary text-xs sm:text-sm">${feedback.volumeCheck}</p>
          </div>
        </div>
      </div>
    `;

    // 最後の質問なら「面接結果を見る」、それ以外は「次の質問へ進む」
    const isLast = (this.currentQuestionIndex + 1 >= this.questionList.length);
    this.btnModalNext.innerText = isLast ? "面接結果を見る" : "次の質問へ進む";

    this.feedbackModal.classList.remove("hidden");
    this.btnModalNext.onclick = () => {
      this.initAudioContext();
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
  showResultScreen() {
    this.setInputAcceptance(false);
    this.stopRecognitionCompletely();
    this.stopTimer();
    this.showView("result");

    const resultSummary = document.getElementById("result-summary");
    const resultList = document.getElementById("result-list");

    const totalQuestions = this.sessionAnswers.length;
    const conclusionCount = this.sessionAnswers.filter(a => a.feedback.isConclusionFirst).length;

    resultSummary.innerHTML = `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="p-4 rounded-xl bg-surface-container-lowest shadow-sm border border-surface-container text-center">
          <p class="text-xs text-on-surface-variant font-medium">回答設問数</p>
          <p class="text-2xl font-bold text-primary mt-0.5">${totalQuestions} <span class="text-xs">問</span></p>
        </div>
        <div class="p-4 rounded-xl bg-surface-container-lowest shadow-sm border border-surface-container text-center">
          <p class="text-xs text-on-surface-variant font-medium">結論ファースト率</p>
          <p class="text-2xl font-bold text-secondary mt-0.5">${Math.round((conclusionCount / totalQuestions) * 100)} <span class="text-xs">%</span></p>
        </div>
        <div class="p-4 rounded-xl bg-surface-container-lowest shadow-sm border border-surface-container text-center">
          <p class="text-xs text-on-surface-variant font-medium">総評</p>
          <p class="text-base font-bold text-tertiary mt-1">大変よく頑張りました！</p>
        </div>
      </div>
    `;

    resultList.innerHTML = this.sessionAnswers.map((item, idx) => `
      <div class="bg-surface-container-lowest rounded-2xl p-4 sm:p-5 shadow-sm border border-surface-container space-y-3">
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
        <div class="p-3.5 bg-surface-container-low rounded-xl space-y-2.5 border border-surface-variant/30">
          <!-- 1. 先生の質問 -->
          <div class="flex items-start gap-2 max-w-[95%]">
            <div class="w-6 h-6 rounded-full bg-primary-container text-on-primary flex items-center justify-center font-bold text-[10px] flex-shrink-0 mt-0.5 shadow-xs">先</div>
            <div class="space-y-0.5">
              <span class="text-[10px] font-bold text-primary">先生の質問</span>
              <div class="p-2.5 rounded-xl rounded-tl-none bg-surface-container-lowest text-on-surface shadow-xs border border-surface-container text-xs sm:text-sm">「${item.question.question.trim()}」</div>
            </div>
          </div>

          <!-- 2. Aさんの回答 -->
          <div class="flex items-start gap-2 max-w-[95%] ml-auto flex-row-reverse">
            <div class="w-6 h-6 rounded-full bg-secondary-fixed text-on-secondary-fixed-variant flex items-center justify-center font-bold text-[10px] flex-shrink-0 mt-0.5 shadow-xs">A</div>
            <div class="space-y-0.5 text-right">
              <span class="text-[10px] font-bold text-secondary">Aさんの回答</span>
              <div class="p-2.5 rounded-xl rounded-tr-none bg-secondary-container text-on-secondary-container shadow-xs border border-secondary/20 text-xs sm:text-sm text-left">「${(item.initialAnswer || "（無回答）").trim()}」</div>
            </div>
          </div>

          <!-- 3. 追加質問＆回答（あれば） -->
          ${item.followUpQuestion ? `
            <div class="pt-2 border-t border-surface-variant/30 space-y-2.5">
              <div class="flex items-start gap-2 max-w-[95%]">
                <div class="w-6 h-6 rounded-full bg-tertiary-fixed text-on-tertiary-fixed-variant flex items-center justify-center font-bold text-[10px] flex-shrink-0 mt-0.5 shadow-xs">追</div>
                <div class="space-y-0.5">
                  <span class="text-[10px] font-bold text-tertiary">追加質問</span>
                  <div class="p-2.5 rounded-xl rounded-tl-none bg-amber-50/50 text-on-surface shadow-xs border border-tertiary/30 text-xs sm:text-sm">「${item.followUpQuestion.trim()}」</div>
                </div>
              </div>

              <div class="flex items-start gap-2 max-w-[95%] ml-auto flex-row-reverse">
                <div class="w-6 h-6 rounded-full bg-secondary-fixed text-on-secondary-fixed-variant flex items-center justify-center font-bold text-[10px] flex-shrink-0 mt-0.5 shadow-xs">A</div>
                <div class="space-y-0.5 text-right">
                  <span class="text-[10px] font-bold text-secondary">Aさんの追加回答</span>
                  <div class="p-2.5 rounded-xl rounded-tr-none bg-secondary-container text-on-secondary-container shadow-xs border border-secondary/20 text-xs sm:text-sm text-left">「${(item.followUpAnswer || "（無回答）").trim()}」</div>
                </div>
              </div>
            </div>
          ` : ""}
        </div>

        <!-- 評価＆アドバイス -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs pt-1">
          <div class="p-3 bg-secondary-fixed/20 rounded-xl text-on-secondary-fixed-variant border border-secondary/20">
            <p class="font-bold mb-0.5 flex items-center gap-1">
              <span class="text-secondary font-bold">✔</span> 良かった点
            </p>
            <p class="leading-relaxed">${item.feedback.goodPoint}</p>
          </div>
          <div class="p-3 bg-tertiary-container/20 rounded-xl text-on-tertiary-container border border-tertiary/20">
            <p class="font-bold mb-0.5 flex items-center gap-1">
              <span class="text-tertiary font-bold">💡</span> 次へのアドバイス
            </p>
            <p class="leading-relaxed">${item.feedback.advice}</p>
          </div>
        </div>

        ${item.feedback.mannerFeedback ? `
        <div class="p-3 bg-primary-fixed/20 rounded-xl text-on-primary-fixed-variant border border-primary/20 text-xs">
          <p class="font-bold mb-0.5 flex items-center gap-1">
            <span class="text-primary font-bold">🎙</span> 話し方のポイント（音声分析）
          </p>
          <p class="leading-relaxed text-on-surface">${item.feedback.mannerFeedback}</p>
        </div>
        ` : ""}
      </div>
    `).join("");
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

    this.initAudioContext();

    // 1. Web Audio API が使用可能な場合は AudioContext で再生（iOSオーディオ排他ロック競合を完全回避）
    if (this.audioCtx) {
      try {
        const buffer = await this.loadAudioBuffer(audioPath);
        if (!buffer) {
          this.isSpeaking = false;
          if (onEndCallback) onEndCallback();
          return;
        }

        // ロード中にユーザーが画面離脱またはスキップした場合は再生中止
        if (!this.isSpeaking) return;

        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioCtx.destination);
        this.currentAudioSource = source;

        let hasFinished = false;
        const finish = () => {
          if (hasFinished) return;
          hasFinished = true;
          this.isSpeaking = false;
          this.currentAudioSource = null;
          if (onEndCallback) onEndCallback();
        };

        source.onended = finish;
        source.start(0);
        return;
      } catch (err) {
        console.warn("Web Audio API 再生エラー、フォールバックを試みます:", err);
      }
    }

    // 2. フォールバック（HTMLAudioElement）
    const audio = new Audio(audioPath);
    this.currentAudio = audio;

    let hasFinished = false;
    const finish = () => {
      if (hasFinished) return;
      hasFinished = true;
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

    audio.onended = finish;
    audio.onerror = (e) => {
      console.warn("音声ファイルの読み込み/再生エラー:", audioPath, e);
      finish();
    };

    audio.play().catch(e => {
      console.warn("音声の自動再生がブロックされたかエラーです:", e);
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

  // --- 読み上げ用テキスト変換（「高志」を「こうし」にフリガナ化） ---
  formatForSpeech(text) {
    if (!text) return "";
    return text
      .replace(/高志中等教育学校/g, "こうしちゅうとうきょういくがっこう")
      .replace(/高志中等/g, "こうしちゅうとう")
      .replace(/本校（高志中等）/g, "本校、こうしちゅうとう")
      .replace(/高志/g, "こうし");
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
