// POST /api/feedback — 回答の正誤フィードバックと未回答質問を全社で集約する
//
// 第1段階では各ブラウザの localStorage に貯めていたため集計が端末ごとに分かれていたが、
// D1(Cloudflare のデータベース)に集約することで、誰がどの回答を誤りと報告したかを
// 一箇所で確認できるようにしている。

import { jsonResponse, getUserEmail, hasDatabase } from "./_lib.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!hasDatabase(env)) {
    // D1 未設定。フロント側は localStorage 保存にフォールバックする。
    return jsonResponse({ error: "db_not_configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const kind = body.kind;
  const question = typeof body.question === "string" ? body.question.slice(0, 1000) : "";
  const email = getUserEmail(request);
  const now = new Date().toISOString();

  if (!question) {
    return jsonResponse({ error: "question_required" }, 400);
  }

  try {
    if (kind === "verdict") {
      if (body.verdict !== "correct" && body.verdict !== "incorrect") {
        return jsonResponse({ error: "invalid_verdict" }, 400);
      }
      await env.DB.prepare(
        `INSERT INTO feedback (created_at, question, answer, entry_ids, verdict, note, user_email)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          now,
          question,
          typeof body.answer === "string" ? body.answer.slice(0, 4000) : null,
          Array.isArray(body.entryIds) ? body.entryIds.join(",") : null,
          body.verdict,
          typeof body.note === "string" ? body.note.slice(0, 1000) : null,
          email
        )
        .run();
      return jsonResponse({ ok: true });
    }

    if (kind === "unanswered") {
      await env.DB.prepare(
        `INSERT INTO unanswered (created_at, question, user_email) VALUES (?, ?, ?)`
      )
        .bind(now, question, email)
        .run();
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "invalid_kind" }, 400);
  } catch (e) {
    console.error("フィードバック保存に失敗", e);
    return jsonResponse({ error: "db_error" }, 500);
  }
}
