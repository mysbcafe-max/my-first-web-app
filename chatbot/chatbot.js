// au サービス案内チャットボット(フロントエンド)
//
// 回答は2経路あり、上から順に試します:
//  1. 生成AI(/api/chat)… Cloudflare 上で動作しているとき。言い回しの揺れに強い
//  2. キーワード検索 … API が使えないとき。ナレッジベースを直接照合する
//
// どちらの経路でも「出典必須・根拠がなければ回答しない」は共通です。
// 生成AI 経路では出典URLをサーバーがナレッジベースから引くため、
// モデルが出典を作文することはできません。

import { AU_KNOWLEDGE } from "./data/knowledge.js";
import {
  askAi,
  sendVerdict,
  sendUnanswered,
  fetchAdminData,
  setEntryDisabled
} from "./api.js";

const STORAGE_KEYS = {
  feedback: "auChatbotFeedback",
  unanswered: "auChatbotUnanswered",
  disabled: "auChatbotDisabled"
};

// キーワード1語一致で回答する。0語一致(=根拠なし)は回答しない。
const SCORE_THRESHOLD = 1;

// サーバーAPI が使えるかどうか。最初の質問時に判明する。
let serverMode = null;

// ---------- ローカル保存(API が使えないときのフォールバック) ----------

function load(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // プライベートモード等で localStorage が使えない場合は収集を諦め、
    // チャット機能自体は動かし続ける
  }
}

function isDisabledLocally(entryId) {
  return load(STORAGE_KEYS.disabled).indexOf(entryId) !== -1;
}

function setDisabledLocally(entryId, disabled) {
  const list = load(STORAGE_KEYS.disabled).filter(function (id) {
    return id !== entryId;
  });
  if (disabled) list.push(entryId);
  save(STORAGE_KEYS.disabled, list);
}

// ---------- キーワード検索(フォールバック経路) ----------

function normalize(text) {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function scoreEntry(entry, query) {
  const q = normalize(query);
  let score = 0;
  entry.keywords.forEach(function (kw) {
    if (q.indexOf(normalize(kw)) !== -1) score += 1;
  });
  if (q.indexOf(normalize(entry.title)) !== -1) score += 2;
  return score;
}

function findBestEntry(query) {
  let best = null;
  let bestScore = 0;
  AU_KNOWLEDGE.forEach(function (entry) {
    if (isDisabledLocally(entry.id)) return; // 誤りと判定され停止中の項目は使わない
    const s = scoreEntry(entry, query);
    if (s > bestScore) {
      best = entry;
      bestScore = s;
    }
  });
  return bestScore >= SCORE_THRESHOLD ? best : null;
}

// ---------- チャット UI ----------

const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const modeBadge = document.getElementById("mode-badge");

function addMessage(role, node) {
  const wrap = document.createElement("div");
  wrap.className = "message message--" + role;
  wrap.appendChild(node);
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
  return wrap;
}

function textNode(text) {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}

function updateModeBadge() {
  if (serverMode === null) {
    modeBadge.textContent = "";
    return;
  }
  modeBadge.textContent = serverMode ? "生成AI 回答モード" : "キーワード検索モード";
  modeBadge.className = "mode-badge " + (serverMode ? "is-ai" : "is-local");
}

// 回答表示。ai / local どちらの経路でも同じ形で描画する。
function buildAnswerNode(result, question) {
  const box = document.createElement("div");

  if (result.title) {
    const title = document.createElement("p");
    title.className = "answer-title";
    title.textContent = result.title;
    box.appendChild(title);
  }

  if (result.unverified) {
    const badge = document.createElement("span");
    badge.className = "badge badge--unverified";
    badge.textContent = "スタッフ未確認の登録情報です。必ず出典で確認してください";
    box.appendChild(badge);
  }

  box.appendChild(textNode(result.answer));

  const srcLabel = document.createElement("p");
  srcLabel.className = "source-label";
  srcLabel.textContent = "出典:";
  box.appendChild(srcLabel);

  const srcList = document.createElement("ul");
  srcList.className = "source-list";
  result.sources.forEach(function (src) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = src.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = src.label + "(" + src.url + ")";
    li.appendChild(a);
    srcList.appendChild(li);
  });
  box.appendChild(srcList);

  if (result.lastVerified) {
    const vd = document.createElement("p");
    vd.className = "verified-date";
    vd.textContent = "スタッフ最終確認日: " + result.lastVerified;
    box.appendChild(vd);
  }

  // フィードバックボタン
  const fb = document.createElement("div");
  fb.className = "feedback";
  const fbLabel = document.createElement("span");
  fbLabel.textContent = "この回答は正確でしたか?";
  fb.appendChild(fbLabel);

  ["正確", "誤りがある"].forEach(function (label, i) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = i === 0 ? "👍 " + label : "👎 " + label;
    btn.addEventListener("click", async function () {
      const record = {
        time: new Date().toISOString(),
        question: question,
        answer: result.answer,
        entryIds: result.entryIds,
        verdict: i === 0 ? "correct" : "incorrect"
      };

      const sent = await sendVerdict(record);
      if (!sent) {
        const list = load(STORAGE_KEYS.feedback);
        list.push(record);
        save(STORAGE_KEYS.feedback, list);
      }

      fb.innerHTML = "";
      fb.appendChild(
        textNode(
          i === 0
            ? "フィードバックを記録しました。ありがとうございます。"
            : "誤りの報告を記録しました。管理パネルで確認のうえ、必要ならこの回答を停止してください。"
        )
      );
      renderAdmin();
    });
    fb.appendChild(btn);
  });
  box.appendChild(fb);

  return box;
}

async function buildNoAnswerNode(question, reason) {
  const box = document.createElement("div");
  box.appendChild(
    textNode(
      reason ||
        "申し訳ありません。この質問に対応する確認済みの情報がナレッジベースに登録されていないため、回答できません。憶測での回答は行わない方針です。"
    )
  );
  box.appendChild(
    textNode(
      "お急ぎの場合は au 公式サポート(https://www.au.com/support/)をご確認ください。" +
        "この質問は「未回答の質問」として記録され、今後の情報登録に活用されます。"
    )
  );

  const sent = await sendUnanswered(question);
  if (!sent) {
    const list = load(STORAGE_KEYS.unanswered);
    list.push({ time: new Date().toISOString(), question: question });
    save(STORAGE_KEYS.unanswered, list);
  }
  renderAdmin();
  return box;
}

async function handleQuestion(question) {
  addMessage("user", textNode(question));

  const pending = addMessage("bot", textNode("回答を準備しています…"));

  // 経路1: 生成AI
  const aiResult = await askAi(question);

  if (aiResult) {
    serverMode = true;
    updateModeBadge();
    pending.remove();
    if (aiResult.answerable) {
      addMessage(
        "bot",
        buildAnswerNode(
          {
            answer: aiResult.answer,
            sources: aiResult.sources,
            entryIds: aiResult.entryIds,
            unverified: aiResult.unverified
          },
          question
        )
      );
    } else {
      addMessage("bot", await buildNoAnswerNode(question, aiResult.answer));
    }
    return;
  }

  // 経路2: キーワード検索へフォールバック
  serverMode = false;
  updateModeBadge();
  pending.remove();

  const entry = findBestEntry(question);
  if (entry) {
    addMessage(
      "bot",
      buildAnswerNode(
        {
          title: entry.title,
          answer: entry.answer,
          sources: entry.sources,
          entryIds: [entry.id],
          unverified: !entry.verified,
          lastVerified: entry.lastVerified
        },
        question
      )
    );
  } else {
    addMessage("bot", await buildNoAnswerNode(question, null));
  }
}

chatForm.addEventListener("submit", function (e) {
  e.preventDefault();
  const q = chatInput.value.trim();
  if (!q) return;
  chatInput.value = "";
  handleQuestion(q);
});

// よくある質問ボタン
const suggestArea = document.getElementById("suggest-buttons");
[
  "auの問い合わせ電話番号は?",
  "近くのauショップを予約したい",
  "請求額はどこで確認できる?",
  "スマホをなくしたときはどうする?"
].forEach(function (q) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = q;
  btn.addEventListener("click", function () {
    handleQuestion(q);
  });
  suggestArea.appendChild(btn);
});

addMessage(
  "bot",
  textNode(
    "こんにちは。au サービス案内チャットボットです。" +
      "スタッフが登録した情報の範囲で、出典付きでお答えします。質問をどうぞ。"
  )
);

// ---------- タブ切り替え ----------

const tabChat = document.getElementById("tab-chat");
const tabAdmin = document.getElementById("tab-admin");
const panelChat = document.getElementById("panel-chat");
const panelAdmin = document.getElementById("panel-admin");

function activate(tab) {
  const chat = tab === "chat";
  tabChat.classList.toggle("is-active", chat);
  tabAdmin.classList.toggle("is-active", !chat);
  panelChat.classList.toggle("is-active", chat);
  panelAdmin.classList.toggle("is-active", !chat);
  if (!chat) renderAdmin();
}
tabChat.addEventListener("click", function () { activate("chat"); });
tabAdmin.addEventListener("click", function () { activate("admin"); });

// ---------- 管理パネル ----------

function renderRows(container, rows, emptyText) {
  container.innerHTML = "";
  if (rows.length === 0) {
    container.appendChild(textNode(emptyText));
    return;
  }
  rows.forEach(function (node) {
    container.appendChild(node);
  });
}

async function renderAdmin() {
  const fbBox = document.getElementById("admin-feedback");
  const unBox = document.getElementById("admin-unanswered");
  const kbBox = document.getElementById("admin-kb");
  const scopeNote = document.getElementById("admin-scope");

  // サーバー集計を優先。使えなければこのブラウザの localStorage を表示する。
  const server = await fetchAdminData();

  if (server) {
    scopeNote.textContent = "全社集計(サーバー保存)を表示しています。";

    renderRows(
      fbBox,
      server.entries
        .filter(function (e) { return e.correct > 0 || e.incorrect > 0; })
        .map(function (e) {
          const row = document.createElement("div");
          row.className = "admin-row";
          row.appendChild(
            textNode(e.title + " — 👍 正確 " + e.correct + " 件 / 👎 誤り " + e.incorrect + " 件")
          );
          return row;
        }),
      "まだフィードバックはありません。"
    );

    renderRows(
      unBox,
      server.unanswered.map(function (u) {
        const row = document.createElement("div");
        row.className = "admin-row";
        row.appendChild(
          textNode(
            u.created_at.slice(0, 16).replace("T", " ") +
              " — " +
              u.question +
              (u.user_email ? "(" + u.user_email + ")" : "")
          )
        );
        return row;
      }),
      "未回答の質問はありません。"
    );

    renderRows(
      kbBox,
      server.entries.map(function (e) {
        const row = document.createElement("div");
        row.className = "admin-row";
        const label = textNode(
          e.title +
            (e.verified ? "(確認済み)" : "(未確認)") +
            (e.disabled ? " — 回答停止中" : "")
        );
        if (e.disabled) label.classList.add("is-disabled");
        row.appendChild(label);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = e.disabled ? "回答を再開する" : "回答を停止する(要修正)";
        btn.addEventListener("click", async function () {
          btn.disabled = true;
          await setEntryDisabled(e.id, !e.disabled);
          renderAdmin();
        });
        row.appendChild(btn);
        return row;
      }),
      "ナレッジベース項目がありません。"
    );
    return;
  }

  // --- フォールバック: このブラウザの localStorage ---
  scopeNote.textContent =
    "このブラウザに保存された分だけを表示しています(サーバー集計は未設定)。";

  const feedback = load(STORAGE_KEYS.feedback);
  const unanswered = load(STORAGE_KEYS.unanswered);

  const byEntry = {};
  feedback.forEach(function (f) {
    (f.entryIds || []).forEach(function (id) {
      if (!byEntry[id]) byEntry[id] = { correct: 0, incorrect: 0 };
      byEntry[id][f.verdict] += 1;
    });
  });

  renderRows(
    fbBox,
    Object.keys(byEntry).map(function (id) {
      const entry = AU_KNOWLEDGE.find(function (e) { return e.id === id; });
      const row = document.createElement("div");
      row.className = "admin-row";
      row.appendChild(
        textNode(
          (entry ? entry.title : id) +
            " — 👍 正確 " + byEntry[id].correct +
            " 件 / 👎 誤り " + byEntry[id].incorrect + " 件"
        )
      );
      return row;
    }),
    "まだフィードバックはありません。"
  );

  renderRows(
    unBox,
    unanswered.slice(-20).reverse().map(function (u) {
      const row = document.createElement("div");
      row.className = "admin-row";
      row.appendChild(textNode(u.time.slice(0, 16).replace("T", " ") + " — " + u.question));
      return row;
    }),
    "未回答の質問はありません。"
  );

  renderRows(
    kbBox,
    AU_KNOWLEDGE.map(function (entry) {
      const row = document.createElement("div");
      row.className = "admin-row";
      const disabled = isDisabledLocally(entry.id);

      const label = textNode(
        entry.title +
          (entry.verified ? "(確認済み)" : "(未確認)") +
          (disabled ? " — 回答停止中" : "")
      );
      if (disabled) label.classList.add("is-disabled");
      row.appendChild(label);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = disabled ? "回答を再開する" : "回答を停止する(要修正)";
      btn.addEventListener("click", function () {
        setDisabledLocally(entry.id, !disabled);
        renderAdmin();
      });
      row.appendChild(btn);
      return row;
    }),
    "ナレッジベース項目がありません。"
  );
}

// エクスポート: このブラウザの収集データを JSON でダウンロード
document.getElementById("export-button").addEventListener("click", function () {
  const data = {
    exportedAt: new Date().toISOString(),
    feedback: load(STORAGE_KEYS.feedback),
    unanswered: load(STORAGE_KEYS.unanswered),
    disabledEntries: load(STORAGE_KEYS.disabled)
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "au-chatbot-feedback-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("clear-button").addEventListener("click", function () {
  if (!confirm("このブラウザに保存された収集データ(フィードバック・未回答質問・停止設定)を消去します。よろしいですか?")) {
    return;
  }
  Object.keys(STORAGE_KEYS).forEach(function (k) {
    localStorage.removeItem(STORAGE_KEYS[k]);
  });
  renderAdmin();
});

updateModeBadge();
renderAdmin();
