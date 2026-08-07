// サーバーAPI クライアント
//
// Cloudflare 上で動かしているときは生成AIの回答とフィードバック集約が使えます。
// API が使えない環境(セットアップ前、ローカルでファイルを直接開いた場合など)では
// 各関数が null / false を返し、呼び出し側がキーワード検索と localStorage に
// 自動でフォールバックします。

async function postJson(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    credentials: "same-origin"
  });
  if (!res.ok) {
    const err = new Error("API error " + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// 生成AIに質問する。API が使えない場合は null を返す(呼び出し側がフォールバック)。
export async function askAi(question) {
  try {
    return await postJson("/api/chat", { question: question });
  } catch (e) {
    return null;
  }
}

export async function sendVerdict(record) {
  try {
    await postJson("/api/feedback", {
      kind: "verdict",
      question: record.question,
      answer: record.answer,
      entryIds: record.entryIds,
      verdict: record.verdict
    });
    return true;
  } catch (e) {
    return false;
  }
}

export async function sendUnanswered(question) {
  try {
    await postJson("/api/feedback", { kind: "unanswered", question: question });
    return true;
  } catch (e) {
    return false;
  }
}

export async function fetchAdminData() {
  try {
    const res = await fetch("/api/admin", { credentials: "same-origin" });
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    return null;
  }
}

export async function setEntryDisabled(entryId, disabled) {
  try {
    await postJson("/api/admin", { entryId: entryId, disabled: disabled });
    return true;
  } catch (e) {
    return false;
  }
}
