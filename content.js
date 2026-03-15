// ============================================================
// content.js - 音声キュー管理と順次再生
// ============================================================

// 音声キュー
let audioQueue = [];
let isPlaying = false;
let waitInterval = null; // waitAndPlayNext のインターバルを追跡する

// background.js からのメッセージを受信
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 全文テキストの取得リクエスト
  if (message.action === "getBodyText") {
    const text = document.body.innerText || "";
    sendResponse({ text });
    return true;
  }

  if (message.action === "enqueue") {
    audioQueue.push({
      audioBase64: message.audioBase64,
      isLast: message.isLast,
      index: message.index,
      total: message.total,
    });
    // 再生中でなければキューの先頭から再生開始
    if (!isPlaying) {
      playNext();
    }
  }

  if (message.action === "clearQueue") {
    audioQueue = [];
    isPlaying = false;
    if (waitInterval) {
      clearInterval(waitInterval);  // 残留インターバルを止める
      waitInterval = null;
    }
    if (window.__voicevoxAudio) {
      window.__voicevoxAudio.pause();
      window.__voicevoxAudio = null;
    }
  }
});

// キューから次の音声を再生する
function playNext() {
  if (audioQueue.length === 0) {
    isPlaying = false;
    return;
  }

  isPlaying = true;
  const item = audioQueue.shift();

  const audio = new Audio(item.audioBase64);
  window.__voicevoxAudio = audio;

  audio.onended = () => {
    window.__voicevoxAudio = null;
    if (item.isLast) {
      isPlaying = false;
      showToast("✅ 読み上げが完了しました", "success");
    } else {
      // 次の文を再生（既にキューに積まれていれば即再生、なければ待機）
      waitAndPlayNext();
    }
  };

  audio.onerror = () => {
    window.__voicevoxAudio = null;
    isPlaying = false;
    showToast("❌ 音声の再生に失敗しました", "error");
  };

  audio.play().catch(() => {
    isPlaying = false;
    showToast("❌ 再生エラーが発生しました", "error");
  });
}

// 次のキューアイテムを待って再生する（合成が追いついていない場合のポーリング）
function waitAndPlayNext() {
  if (audioQueue.length > 0) {
    playNext();
  } else {
    // isLast が来るまで無制限に待機する（停止時は clearQueue でインターバルが止まる）
    waitInterval = setInterval(() => {
      if (audioQueue.length > 0) {
        clearInterval(waitInterval);
        waitInterval = null;
        playNext();
      }
    }, 50);
  }
}

// トースト通知
function showToast(message, type) {
  const colors = { info: "#3b82f6", success: "#22c55e", stop: "#f59e0b", error: "#ef4444" };
  const existing = document.getElementById("voicevox-toast");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "voicevox-toast";
  el.textContent = message;
  Object.assign(el.style, {
    position: "fixed", bottom: "24px", right: "24px",
    background: colors[type] || "#3b82f6", color: "#fff",
    padding: "12px 20px", borderRadius: "8px", fontSize: "14px",
    fontFamily: "sans-serif", boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
    zIndex: "2147483647", transition: "opacity 0.4s ease", opacity: "1",
  });
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 400); }, 3000);
}
