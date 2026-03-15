// ============================================================
// background.js - VOICEVOX TTS Chrome拡張機能 サービスワーカー
// ============================================================

const VOICEVOX_URL = "http://localhost:50021";

// セッションID（タブIDごとに管理）
// 読み上げのたびに新しいIDを発番し、古いループが自分のIDと違ったら中断する
const sessionIds = {};

// --- 初期化 ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["speakerId", "speed", "pitch", "volume"], (result) => {
    if (result.speakerId === undefined) {
      chrome.storage.sync.set({ speakerId: 1, speed: 1.0, pitch: 0.0, volume: 1.0 });
    }
  });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "voicevox-read-selection",
      title: "🔊 VOICEVOXで読み上げる",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "voicevox-read-fullpage",
      title: "🔊 VOICEVOXで読み上げる（全文）",
      contexts: ["page"],
    });

    chrome.contextMenus.create({
      id: "voicevox-stop",
      title: "⏹ 読み上げを停止する",
      contexts: ["all"],
    });
  });
});

// --- コンテキストメニュークリック ---
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "voicevox-read-selection") {
    const text = info.selectionText?.trim();
    if (!text) return;

    // 新しいセッションIDを発番（古いループはこのIDと一致しないので自動的に停止する）
    const sessionId = Date.now();
    sessionIds[tab.id] = sessionId;
    chrome.tabs.sendMessage(tab.id, { action: "clearQueue" });

    showToastOnTab(tab.id, "🔊 読み上げを開始します...", "info");
    await speakTextInChunks(text, tab.id, sessionId);
  }

  if (info.menuItemId === "voicevox-read-fullpage") {
    // content.js に全文取得を依頼
    chrome.tabs.sendMessage(tab.id, { action: "getBodyText" }, async (response) => {
      const text = response?.text?.trim();
      if (!text) {
        showToastOnTab(tab.id, "❌ テキストを取得できませんでした", "error");
        return;
      }
      const sessionId = Date.now();
      sessionIds[tab.id] = sessionId;
      chrome.tabs.sendMessage(tab.id, { action: "clearQueue" });
      showToastOnTab(tab.id, "🔊 全文の読み上げを開始します...", "info");
      await speakTextInChunks(text, tab.id, sessionId);
    });
  }


  if (info.menuItemId === "voicevox-stop") {
    sessionIds[tab.id] = null;
    chrome.tabs.sendMessage(tab.id, { action: "clearQueue" });
    showToastOnTab(tab.id, "⏹ 読み上げを停止しました", "stop");
  }
});

// --- ポップアップからのメッセージ ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "speak") {
    const tabId = message.tabId ?? null;
    const sessionId = Date.now();
    if (tabId) sessionIds[tabId] = sessionId;
    speakTextInChunks(message.text, tabId, sessionId)
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (message.action === "stop") {
    if (message.tabId) sessionIds[message.tabId] = null;
    sendResponse({ success: true });
    return true;
  }
});

// ============================================================
// テキストを文に分割して順次合成・送信する
// ============================================================
async function speakTextInChunks(text, tabId, sessionId) {
  const settings = await chrome.storage.sync.get(["speakerId", "speed", "pitch", "volume"]);
  const speakerId = settings.speakerId ?? 1;
  const speed     = settings.speed  ?? 1.0;
  const pitch     = settings.pitch  ?? 0.0;
  const volume    = settings.volume ?? 1.0;

  const sentences = splitSentences(text);
  if (sentences.length === 0) return;

  for (let i = 0; i < sentences.length; i++) {
    // 自分のセッションIDが現在のIDと一致しない場合は中断（新しい読み上げが始まった or 停止された）
    if (tabId && sessionIds[tabId] !== sessionId) break;

    const sentence = sentences[i];
    if (!sentence.trim()) continue;

    try {
      const audioBase64 = await synthesize(sentence, speakerId, speed, pitch, volume);

      // synthesize中にセッションが変わっていたら送信しない
      if (tabId && sessionIds[tabId] !== sessionId) break;

      const isLast = (i === sentences.length - 1);
      if (tabId !== null) {
        chrome.tabs.sendMessage(tabId, {
          action: "enqueue",
          audioBase64,
          isLast,
          index: i,
          total: sentences.length,
        });
      }
    } catch (err) {
      console.error(`[VOICEVOX TTS] 文[${i}]の合成エラー:`, err);
      if (tabId !== null) {
        showToastOnTab(tabId, `エラー: ${err.message}`, "error");
      }
      break;
    }
  }
}

// ============================================================
// 1文を合成して Base64 を返す
// ============================================================
async function synthesize(text, speakerId, speed, pitch, volume) {
  const queryRes = await fetch(
    `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
    { method: "POST" }
  );
  if (!queryRes.ok) {
    throw new Error(`audio_query 失敗 (${queryRes.status}) VOICEVOXが起動しているか確認してください`);
  }
  const query = await queryRes.json();
  query.speedScale  = speed;
  query.pitchScale  = pitch;
  query.volumeScale = volume;

  const synthRes = await fetch(
    `${VOICEVOX_URL}/synthesis?speaker=${speakerId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    }
  );
  if (!synthRes.ok) {
    throw new Error(`synthesis 失敗 (${synthRes.status})`);
  }

  const blob = await synthRes.blob();
  return await blobToBase64(blob);
}

// ============================================================
// テキストを文単位に分割する
// ============================================================
function splitSentences(text) {
  // 。！？.!? の直後で分割（区切り文字は前の文に含める）
  const raw = text
    .split(/(?<=[。！？.!?]+)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // 短すぎる断片（2文字以下）は直前の文に結合する
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

// Blob → Base64
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// タブにトーストを表示する
async function showToastOnTab(tabId, message, type) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg, t) => {
        const colors = { info: "#3b82f6", success: "#22c55e", stop: "#f59e0b", error: "#ef4444" };
        const existing = document.getElementById("voicevox-toast");
        if (existing) existing.remove();
        const el = document.createElement("div");
        el.id = "voicevox-toast";
        el.textContent = msg;
        Object.assign(el.style, {
          position: "fixed", bottom: "24px", right: "24px",
          background: colors[t] || "#3b82f6", color: "#fff",
          padding: "12px 20px", borderRadius: "8px", fontSize: "14px",
          fontFamily: "sans-serif", boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          zIndex: "2147483647", transition: "opacity 0.4s ease", opacity: "1",
        });
        document.body.appendChild(el);
        setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 400); }, 3000);
      },
      args: [message, type],
    });
  } catch (_) {}
}
