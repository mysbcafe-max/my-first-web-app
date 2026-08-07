// au サービス案内チャットボット
//
// 動作原理:
// - data/knowledge.js のナレッジベース(KB)をキーワード一致でスコアリングし、
//   閾値を超えた項目だけを回答に使う(閾値未満 = 根拠なし = 回答しない)
// - 回答には必ず出典リンクを付ける。出典のない回答は生成されない
// - 回答ごとに「正確 / 誤り」のフィードバックを収集し localStorage に保存
// - 管理パネルで正誤を確認し、誤答は「回答停止」で即時に本番回答から除外できる
//   (恒久的な修正は knowledge.js を直す PR で行う)

(function () {
  "use strict";

  var STORAGE_KEYS = {
    feedback: "auChatbotFeedback",     // [{time, question, entryId, verdict}]
    unanswered: "auChatbotUnanswered", // [{time, question}]
    disabled: "auChatbotDisabled"      // [entryId]
  };

  // スコア閾値: キーワード 1 語一致では回答するが、それ未満(0)は回答しない
  var SCORE_THRESHOLD = 1;

  // ---------- ストレージ ----------

  function load(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // localStorage が使えない環境(プライベートモード等)では収集をあきらめ、
      // チャット機能自体は動かし続ける
    }
  }

  function isDisabled(entryId) {
    return load(STORAGE_KEYS.disabled).indexOf(entryId) !== -1;
  }

  function setDisabled(entryId, disabled) {
    var list = load(STORAGE_KEYS.disabled).filter(function (id) {
      return id !== entryId;
    });
    if (disabled) list.push(entryId);
    save(STORAGE_KEYS.disabled, list);
  }

  // ---------- 検索(リトリーバル) ----------

  function normalize(text) {
    return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function scoreEntry(entry, query) {
    var q = normalize(query);
    var score = 0;
    entry.keywords.forEach(function (kw) {
      if (q.indexOf(normalize(kw)) !== -1) score += 1;
    });
    if (q.indexOf(normalize(entry.title)) !== -1) score += 2;
    return score;
  }

  function findBestEntry(query) {
    var best = null;
    var bestScore = 0;
    AU_KNOWLEDGE.forEach(function (entry) {
      if (isDisabled(entry.id)) return; // 誤りと判定され停止中の項目は使わない
      var s = scoreEntry(entry, query);
      if (s > bestScore) {
        best = entry;
        bestScore = s;
      }
    });
    return bestScore >= SCORE_THRESHOLD ? best : null;
  }

  // ---------- チャット UI ----------

  var chatLog = document.getElementById("chat-log");
  var chatForm = document.getElementById("chat-form");
  var chatInput = document.getElementById("chat-input");

  function addMessage(role, node) {
    var wrap = document.createElement("div");
    wrap.className = "message message--" + role;
    wrap.appendChild(node);
    chatLog.appendChild(wrap);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function textNode(text) {
    var p = document.createElement("p");
    p.textContent = text;
    return p;
  }

  function buildAnswerNode(entry, question) {
    var box = document.createElement("div");

    var title = document.createElement("p");
    title.className = "answer-title";
    title.textContent = entry.title;
    box.appendChild(title);

    if (!entry.verified) {
      var badge = document.createElement("span");
      badge.className = "badge badge--unverified";
      badge.textContent = "スタッフ未確認の登録情報です。必ず出典で確認してください";
      box.appendChild(badge);
    }

    box.appendChild(textNode(entry.answer));

    var srcLabel = document.createElement("p");
    srcLabel.className = "source-label";
    srcLabel.textContent = "出典:";
    box.appendChild(srcLabel);

    var srcList = document.createElement("ul");
    srcList.className = "source-list";
    entry.sources.forEach(function (src) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = src.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = src.label + "(" + src.url + ")";
      li.appendChild(a);
      srcList.appendChild(li);
    });
    box.appendChild(srcList);

    if (entry.lastVerified) {
      var vd = document.createElement("p");
      vd.className = "verified-date";
      vd.textContent = "スタッフ最終確認日: " + entry.lastVerified;
      box.appendChild(vd);
    }

    // フィードバックボタン
    var fb = document.createElement("div");
    fb.className = "feedback";
    var fbLabel = document.createElement("span");
    fbLabel.textContent = "この回答は正確でしたか?";
    fb.appendChild(fbLabel);

    ["正確", "誤りがある"].forEach(function (label, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = i === 0 ? "👍 " + label : "👎 " + label;
      btn.addEventListener("click", function () {
        var list = load(STORAGE_KEYS.feedback);
        list.push({
          time: new Date().toISOString(),
          question: question,
          entryId: entry.id,
          verdict: i === 0 ? "correct" : "incorrect"
        });
        save(STORAGE_KEYS.feedback, list);
        fb.innerHTML = "";
        fb.appendChild(textNode(
          i === 0
            ? "フィードバックを記録しました。ありがとうございます。"
            : "誤りの報告を記録しました。管理パネルで確認のうえ、必要ならこの回答を停止してください。"
        ));
        renderAdmin();
      });
      fb.appendChild(btn);
    });
    box.appendChild(fb);

    return box;
  }

  function buildNoAnswerNode(question) {
    var box = document.createElement("div");
    box.appendChild(textNode(
      "申し訳ありません。この質問に対応する確認済みの情報がナレッジベースに登録されていないため、回答できません。" +
      "憶測での回答は行わない方針です。"
    ));
    box.appendChild(textNode(
      "お急ぎの場合は au 公式サポート(https://www.au.com/support/)をご確認ください。" +
      "この質問は「未回答の質問」として記録され、今後の情報登録に活用されます。"
    ));
    var list = load(STORAGE_KEYS.unanswered);
    list.push({ time: new Date().toISOString(), question: question });
    save(STORAGE_KEYS.unanswered, list);
    renderAdmin();
    return box;
  }

  function handleQuestion(question) {
    addMessage("user", textNode(question));
    var entry = findBestEntry(question);
    if (entry) {
      addMessage("bot", buildAnswerNode(entry, question));
    } else {
      addMessage("bot", buildNoAnswerNode(question));
    }
  }

  chatForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = chatInput.value.trim();
    if (!q) return;
    chatInput.value = "";
    handleQuestion(q);
  });

  // よくある質問ボタン(KB の代表項目から生成)
  var suggestArea = document.getElementById("suggest-buttons");
  [
    "auの問い合わせ電話番号は?",
    "近くのauショップを予約したい",
    "請求額はどこで確認できる?",
    "スマホをなくしたときはどうする?"
  ].forEach(function (q) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = q;
    btn.addEventListener("click", function () {
      handleQuestion(q);
    });
    suggestArea.appendChild(btn);
  });

  // 初回メッセージ
  addMessage("bot", textNode(
    "こんにちは。au サービス案内チャットボットです。" +
    "スタッフが登録した情報の範囲で、出典付きでお答えします。質問をどうぞ。"
  ));

  // ---------- タブ切り替え ----------

  var tabChat = document.getElementById("tab-chat");
  var tabAdmin = document.getElementById("tab-admin");
  var panelChat = document.getElementById("panel-chat");
  var panelAdmin = document.getElementById("panel-admin");

  function activate(tab) {
    var chat = tab === "chat";
    tabChat.classList.toggle("is-active", chat);
    tabAdmin.classList.toggle("is-active", !chat);
    panelChat.classList.toggle("is-active", chat);
    panelAdmin.classList.toggle("is-active", !chat);
    if (!chat) renderAdmin();
  }
  tabChat.addEventListener("click", function () { activate("chat"); });
  tabAdmin.addEventListener("click", function () { activate("admin"); });

  // ---------- 管理パネル ----------

  function renderAdmin() {
    var feedback = load(STORAGE_KEYS.feedback);
    var unanswered = load(STORAGE_KEYS.unanswered);

    // 回答フィードバック(項目ごとの集計)
    var fbBox = document.getElementById("admin-feedback");
    fbBox.innerHTML = "";
    if (feedback.length === 0) {
      fbBox.appendChild(textNode("まだフィードバックはありません。"));
    } else {
      var byEntry = {};
      feedback.forEach(function (f) {
        byEntry[f.entryId] = byEntry[f.entryId] || { correct: 0, incorrect: 0 };
        byEntry[f.entryId][f.verdict] += 1;
      });
      Object.keys(byEntry).forEach(function (id) {
        var entry = AU_KNOWLEDGE.filter(function (e) { return e.id === id; })[0];
        var row = document.createElement("div");
        row.className = "admin-row";
        var name = entry ? entry.title : id;
        row.appendChild(textNode(
          name + " — 👍 正確 " + byEntry[id].correct + " 件 / 👎 誤り " + byEntry[id].incorrect + " 件"
        ));
        fbBox.appendChild(row);
      });
    }

    // 未回答の質問
    var unBox = document.getElementById("admin-unanswered");
    unBox.innerHTML = "";
    if (unanswered.length === 0) {
      unBox.appendChild(textNode("未回答の質問はありません。"));
    } else {
      unanswered.slice(-20).reverse().forEach(function (u) {
        var row = document.createElement("div");
        row.className = "admin-row";
        row.appendChild(textNode(u.time.slice(0, 16).replace("T", " ") + " — " + u.question));
        unBox.appendChild(row);
      });
    }

    // KB の状態と回答停止トグル
    var kbBox = document.getElementById("admin-kb");
    kbBox.innerHTML = "";
    AU_KNOWLEDGE.forEach(function (entry) {
      var row = document.createElement("div");
      row.className = "admin-row";
      var disabled = isDisabled(entry.id);

      var label = textNode(
        entry.title +
        (entry.verified ? "(確認済み)" : "(未確認)") +
        (disabled ? " — 回答停止中" : "")
      );
      if (disabled) label.classList.add("is-disabled");
      row.appendChild(label);

      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = disabled ? "回答を再開する" : "回答を停止する(要修正)";
      btn.addEventListener("click", function () {
        setDisabled(entry.id, !disabled);
        renderAdmin();
      });
      row.appendChild(btn);
      kbBox.appendChild(row);
    });
  }

  // エクスポート: 収集データを JSON ファイルとしてダウンロード
  document.getElementById("export-button").addEventListener("click", function () {
    var data = {
      exportedAt: new Date().toISOString(),
      feedback: load(STORAGE_KEYS.feedback),
      unanswered: load(STORAGE_KEYS.unanswered),
      disabledEntries: load(STORAGE_KEYS.disabled)
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
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

  renderAdmin();
})();
