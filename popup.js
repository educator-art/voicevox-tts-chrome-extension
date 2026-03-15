// ============================================================
// popup.js - 設定管理とテスト読み上げ（文分割パイプライン版）
// ============================================================

const VOICEVOX_URL = "http://localhost:50021";

const statusDot     = document.getElementById("statusDot");
const statusText    = document.getElementById("statusText");
const statusLabel   = document.getElementById("statusLabel");
const statusVersion = document.getElementById("statusVersion");
const speakerSel  = document.getElementById("speakerSelect");
const speedSlider = document.getElementById("speed");
const pitchSlider = document.getElementById("pitch");
const volSlider   = document.getElementById("volume");
const speedVal    = document.getElementById("speedVal");
const pitchVal    = document.getElementById("pitchVal");
const volumeVal   = document.getElementById("volumeVal");
const testTextEl  = document.getElementById("testText");
const speakBtn    = document.getElementById("speakBtn");
const stopBtn     = document.getElementById("stopBtn");
const toast       = document.getElementById("popup-toast");

let audioQueue   = [];
let isPlaying    = false;
let stopRequested = false;
let waitIv = null; // 待機インターバルを追跡する
let synthesisComplete = false; // 全文の合成が終わったかどうか

// --- VOICEVOX 接続確認 ---
async function checkConnection() {
  try {
    const res = await fetch(`${VOICEVOX_URL}/version`);
    if (res.ok) {
      const v = (await res.text()).replace(/"/g, "");
      statusDot.className = "status-dot connected";
      statusLabel.textContent = "VOICEVOX 接続済み";
      statusVersion.textContent = `　v${v}`;
    } else throw new Error();
  } catch {
    statusDot.className = "status-dot";
    statusLabel.className = "error";
    statusLabel.textContent = "未接続　VOICEVOXを起動してください";
    statusVersion.textContent = "";
  }
}

// --- 設定の読み込み・保存 ---
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["speakerId", "speed", "pitch", "volume"], (r) => {
      speakerSel.value  = String(r.speakerId ?? 1);
      speedSlider.value = r.speed  ?? 1.0;
      pitchSlider.value = r.pitch  ?? 0.0;
      volSlider.value   = r.volume ?? 1.0;
      updateDisplayValues();
      resolve();
    });
  });
}

function saveSettings() {
  chrome.storage.sync.set({
    speakerId: Number(speakerSel.value),
    speed:  Number(speedSlider.value),
    pitch:  Number(pitchSlider.value),
    volume: Number(volSlider.value),
  });
}

function updateDisplayValues() {
  speedVal.textContent  = Number(speedSlider.value).toFixed(1);
  pitchVal.textContent  = Number(pitchSlider.value).toFixed(2);
  volumeVal.textContent = Number(volSlider.value).toFixed(1);
}

// --- 文分割 ---
function splitSentences(text) {
  const raw = text
    .split(/(?<=[。！？.!?]+)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const merged = [];
  for (const s of raw) {
    if (merged.length > 0 && s.length <= 2) {
      merged[merged.length - 1] += s;
    } else {
      merged.push(s);
    }
  }
  return merged;
}

// --- 1文合成 ---
async function synthesize(text, speakerId, speed, pitch, volume) {
  const queryRes = await fetch(
    `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
    { method: "POST" }
  );
  if (!queryRes.ok) throw new Error(`audio_query 失敗 (${queryRes.status})`);
  const query = await queryRes.json();
  query.speedScale  = speed;
  query.pitchScale  = pitch;
  query.volumeScale = volume;

  const synthRes = await fetch(
    `${VOICEVOX_URL}/synthesis?speaker=${speakerId}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query) }
  );
  if (!synthRes.ok) throw new Error(`synthesis 失敗 (${synthRes.status})`);

  const blob = await synthRes.blob();
  return URL.createObjectURL(blob);
}

// --- キューから順次再生 ---
function playNext() {
  if (audioQueue.length === 0) {
    isPlaying = false;
    speakBtn.disabled = false;
    speakBtn.textContent = "▶ 読み上げ";
    return;
  }
  isPlaying = true;
  const url = audioQueue.shift();
  const audio = new Audio(url);
  window.__popupAudio = audio;

  audio.onended = () => {
    URL.revokeObjectURL(url);
    window.__popupAudio = null;
    if (audioQueue.length > 0) {
      playNext();
    } else {
      // キューが空 → 合成完了まで無制限に待機（停止時は stopTest() から直接クリア）
      waitIv = setInterval(() => {
        if (audioQueue.length > 0 || stopRequested) {
          clearInterval(waitIv);
          waitIv = null;
          if (!stopRequested) playNext();
          else { isPlaying = false; speakBtn.disabled = false; speakBtn.textContent = "▶ 読み上げ"; }
        } else if (synthesisComplete) {
          // 合成も完了済みでキューも空 → 全文再生完了
          clearInterval(waitIv);
          waitIv = null;
          isPlaying = false;
          speakBtn.disabled = false;
          speakBtn.textContent = "▶ 読み上げ";
          showPopupToast("✅ 読み上げが完了しました");
        }
      }, 50);
    }
  };

  audio.onerror = () => {
    URL.revokeObjectURL(url);
    isPlaying = false;
    speakBtn.disabled = false;
    speakBtn.textContent = "▶ 読み上げ";
    showPopupToast("❌ 再生エラー");
  };

  audio.play();
  speakBtn.textContent = "🔊 再生中...";
}

// --- テスト読み上げ開始 ---
async function speakTest() {
  const text = testTextEl.value.trim();
  if (!text) { showPopupToast("テキストを入力してください"); return; }

  // waitIv が残っていたら先にクリア（isPlaying もリセットする）
  if (waitIv) {
    clearInterval(waitIv);
    waitIv = null;
    isPlaying = false;
  }

  synthesisComplete = false;
  stopRequested = false;
  audioQueue = [];
  speakBtn.disabled = true;
  speakBtn.textContent = "⏳ 合成中...";

  const speakerId = Number(speakerSel.value);
  const speed  = Number(speedSlider.value);
  const pitch  = Number(pitchSlider.value);
  const volume = Number(volSlider.value);
  const sentences = splitSentences(text);

  // 文を順次合成してキューに積む（再生と並走）
  (async () => {
    for (let i = 0; i < sentences.length; i++) {
      if (stopRequested) break;
      try {
        const url = await synthesize(sentences[i], speakerId, speed, pitch, volume);
        if (stopRequested) { URL.revokeObjectURL(url); break; }
        audioQueue.push(url);
        if (!isPlaying) playNext();
      } catch (err) {
        showPopupToast("❌ " + err.message);
        break;
      }
    }
    synthesisComplete = true; // 合成ループ終了
  })();
}

// --- 停止 ---
function stopTest() {
  stopRequested = true;
  audioQueue = [];
  if (waitIv) {
    clearInterval(waitIv);
    waitIv = null;
  }
  if (window.__popupAudio) {
    window.__popupAudio.pause();
    window.__popupAudio = null;
  }
  isPlaying = false;
  speakBtn.disabled = false;
  speakBtn.textContent = "▶ 読み上げ";
  showPopupToast("⏹ 停止しました");
}

// --- ポップアップ内トースト ---
function showPopupToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

// --- イベントリスナー ---
speakerSel.addEventListener("change",  saveSettings);
speedSlider.addEventListener("input",  () => { updateDisplayValues(); saveSettings(); });
pitchSlider.addEventListener("input",  () => { updateDisplayValues(); saveSettings(); });
volSlider.addEventListener("input",    () => { updateDisplayValues(); saveSettings(); });
speakBtn.addEventListener("click", speakTest);
stopBtn.addEventListener("click",  stopTest);

// --- 初期化 ---
(async () => {
  await loadSettings();
  await checkConnection();
})();
