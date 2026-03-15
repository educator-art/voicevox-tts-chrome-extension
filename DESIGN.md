# VOICEVOX TTS Chrome拡張機能 設計書

---

## 1. 概要

WebページやポップアップUIで選択・取得したテキストを、ローカルで動作するVOICEVOX（音声合成エンジン）に送信し、文ごとに分割して順次合成・再生するChrome拡張機能。

---

## 2. ファイル構成と役割

```
voicevox-tts-extension/
├── manifest.json   # 拡張機能の定義・権限設定
├── background.js   # サービスワーカー（合成・コンテキストメニュー管理）
├── content.js      # コンテンツスクリプト（音声キュー管理・順次再生）
├── popup.html      # ポップアップUI
├── popup.js        # ポップアップのロジック（設定・テスト読み上げ）
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

| ファイル | 動作する場所 | 主な責務 |
|---|---|---|
| `background.js` | Chromeバックグラウンド | コンテキストメニュー管理、VOICEVOX API呼び出し、文分割、セッション管理 |
| `content.js` | Webページ内 | 音声キューの管理、順次再生、テキスト全文取得 |
| `popup.js` | ポップアップ画面内 | 設定の読み書き、テスト読み上げ（合成・再生を独立して管理） |

`popup.js` はWebページとは別の独立したHTMLページ（`popup.html`）上で動作するため、`content.js` とは完全に切り離されている。合成・再生をすべて `popup.js` 単体で処理する。

---

## 3. アーキテクチャ概要

### 右クリック読み上げ（メインフロー）

```
ユーザー操作（右クリック）
    ↓
background.js
  ├─ テキストを文に分割
  ├─ 1文ずつ VOICEVOX API へ合成リクエスト
  └─ 合成済み音声を chrome.tabs.sendMessage で content.js へ送信
    ↓
content.js
  ├─ 音声をキューに積む（enqueue）
  └─ 順番に再生（再生完了 → 次をキューから取り出す）
```

### テスト読み上げ（ポップアップ独立フロー）

```
ポップアップ画面（popup.js）
  ├─ テキストを文に分割
  ├─ 1文ずつ VOICEVOX API へ合成リクエスト
  └─ 合成済み音声をキューに積み、順次再生
```

---

## 4. コンテキストメニュー仕様

| メニュー項目 | contexts | 表示条件 |
|---|---|---|
| 🔊 VOICEVOXで読み上げる | `selection` | テキスト選択中のみ |
| 🔊 VOICEVOXで読み上げる（全文） | `page` | テキスト非選択時のみ |
| ⏹ 読み上げを停止する | `all` | 常時 |

`selection` と `page` を使い分けることで、テキスト選択中に「全文」が表示されるという矛盾を防いでいる。

---

## 5. 文分割ロジック（`splitSentences`）

`background.js` と `popup.js` の両方に同一ロジックを実装している（Chromeの制約上、ファイル間でのコード共有が難しいため重複している）。

- `。！？.!?` の直後を区切りとして分割（区切り文字は前の文に含める）
- 分割後に2文字以下の断片（「ね。」「よ。」など）が生じた場合は直前の文に結合する

```
「こんにちは。今日はいい天気ですね！ところで調子はどうですか？」
  → ["こんにちは。", "今日はいい天気ですね！", "ところで調子はどうですか？"]
```

---

## 6. 合成・再生パイプライン

合成と再生は**並走**する。全文の合成完了を待ってから再生するのではなく、最初の1文が合成され次第すぐに再生が始まり、再生中に次の文の合成が進む。

```
時間軸 →

background.js（合成）: [文1合成]→[文2合成]→[文3合成]→ ...
content.js  （再生）:        [文1再生------][文2再生------][文3再生------]
```

### 再生待機の仕組み

再生が合成より速く進んだとき（キューが空になったとき）、50msごとにキューを監視するインターバルを起動し、次の音声が届くまで**無制限に待機**する。届いた瞬間に即再生を再開する。

```javascript
// content.js の例
waitInterval = setInterval(() => {
  if (audioQueue.length > 0) {
    clearInterval(waitInterval);
    waitInterval = null;
    playNext();
  }
}, 50);
```

タイムアウトは設けていないため、VOICEVOXの合成が遅延しても途中で止まらない。

### `isLast` フラグによる終了検知

background.js は最後の文を送信するときに `isLast: true` を付与する。content.js 側はこのフラグを受け取ったとき、インターバルではなく正常終了として処理する。

```javascript
if (item.isLast) {
  isPlaying = false;
  showToast("✅ 読み上げが完了しました", "success");
} else {
  waitAndPlayNext(); // まだ続きがある → 待機
}
```

---

## 7. セッション管理（二重再生防止）

同一タブで再度読み上げを開始したとき、古い合成ループが新しい読み上げと混在するのを防ぐために**セッションID**を使用する。

```javascript
// 読み上げ開始時
const sessionId = Date.now();
sessionIds[tab.id] = sessionId;

// 合成ループ内（毎文ごとにチェック）
if (sessionIds[tabId] !== sessionId) break; // 自分のIDと違えば即中断
```

`true/false` のフラグではなく数値IDを使うことで、フラグを戻すタイミングの競合問題を解消している。新しい読み上げが始まった瞬間に古いループは自動的に無効化される。

---

## 8. 停止処理

### 右クリック「停止」の場合（content.js）

1. `sessionIds[tab.id] = null` → 合成ループを中断
2. `clearQueue` メッセージを `content.js` へ送信
3. キューを空にし、再生中の音声を即停止、`waitInterval` を直接 `clearInterval` で破棄

### ポップアップ「停止」の場合（popup.js）

1. `stopRequested = true` → 合成ループを中断
2. キューを空にし、再生中の音声を即停止
3. `waitIv` を直接 `clearInterval` で破棄

どちらも**インターバルをモジュールレベルの変数で管理**しているため、停止処理から直接 `clearInterval` できる設計で統一されている。

| | インターバル変数 | 停止トリガー |
|---|---|---|
| `content.js` | `waitInterval` | `clearQueue` メッセージ受信時 |
| `popup.js` | `waitIv` | `stopTest()` 呼び出し時 |

---

## 9. タブ分離の仕様

セッション管理・キュー管理はタブIDごとに独立している。複数タブで同時に読み上げを行うことは可能だが、以下の制約がある。

- 別タブの読み上げを別タブから停止することはできない（各タブで停止メニューを使う）
- 複数タブから同時にVOICEVOXへリクエストが飛ぶと合成が遅延する場合がある

---

## 10. VOICEVOX APIとの通信フロー

1文ずつ順番にリクエストを送る（並列リクエストなし）。

```
STEP 1: POST /audio_query?text={文}&speaker={id}
        → 音声パラメータ（JSON）を取得

STEP 2: パラメータに speedScale / pitchScale / volumeScale を上書き

STEP 3: POST /synthesis?speaker={id}  ボディ: STEP2のJSON
        → WAV音声データ（Blob）を取得

STEP 4: Blob を Base64 に変換して content.js へ送信
        （popup.js の場合は ObjectURL に変換して直接再生）
```

停止ボタンを押しても現在進行中の fetch は中断できない。fetch 完了後にセッションIDを確認して結果を破棄する設計のため、現在合成中の1文分だけVOICEVOXの生成が最後まで走る。

---

## 11. 設定の永続化

`chrome.storage.sync` を使用し、ブラウザ間で同期保存する。

| キー | デフォルト値 | 説明 |
|---|---|---|
| `speakerId` | `1` | 話者キャラクターID |
| `speed` | `1.0` | 話速（0.5〜2.0） |
| `pitch` | `0.0` | ピッチ（-0.15〜0.15） |
| `volume` | `1.0` | 音量（0.1〜2.0） |

---

## 12. 既知の制約事項

| 制約 | 内容 |
|---|---|
| CSP制限 | サイトによってはContent Security Policyにより音声再生がブロックされる場合がある（拡張機能は止まらないがエラートーストが表示される） |
| 停止の遅延 | 合成中のfetchは即座にキャンセルできないため、現在合成中の1文は最後まで生成される |
| タブをまたいだ停止 | 他タブの読み上げを別タブから停止する手段はない |
| 全文取得の精度 | 「全文読み上げ」は `document.body.innerText` を使用するため、ナビゲーションやフッターなどのノイズが混入する場合がある |
