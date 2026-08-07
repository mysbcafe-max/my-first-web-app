// GET  /api/admin — 管理パネル用の集計データ(フィードバック・未回答質問・停止中項目)
// POST /api/admin — 誤答項目の回答停止 / 再開(全社に即時反映)
//
// このエンドポイントは Cloudflare Access の認証を通った利用者だけが到達できる。
// (Access はサイト全体のホスト名の手前に立つため、/api/* も同じ認証で保護される)

import { AU_KNOWLEDGE } from "../../chatbot/data/knowledge.js";
import { jsonResponse, getUserEmail, hasDatabase, getDisabledEntryIds } from "./_lib.js";

export async function onRequestGet(context) {
  const { env } = context;

  if (!hasDatabase(env)) {
    return jsonResponse({ error: "db_not_configured" }, 503);
  }

  try {
    const [verdicts, unanswered, disabled] = await Promise.all([
      env.DB.prepare(
        `SELECT entry_ids, verdict, COUNT(*) AS count
           FROM feedback
          GROUP BY entry_ids, verdict`
      ).all(),
      env.DB.prepare(
        `SELECT created_at, question, user_email
           FROM unanswered
          ORDER BY created_at DESC
          LIMIT 50`
      ).all(),
      getDisabledEntryIds(env)
    ]);

    // entry_ids は複数idのカンマ区切りなので、項目ごとに割り戻して集計する
    const byEntry = {};
    (verdicts.results || []).forEach(function (row) {
      const ids = (row.entry_ids || "").split(",").filter(Boolean);
      ids.forEach(function (id) {
        if (!byEntry[id]) byEntry[id] = { correct: 0, incorrect: 0 };
        byEntry[id][row.verdict] += row.count;
      });
    });

    return jsonResponse({
      entries: AU_KNOWLEDGE.map(function (e) {
        return {
          id: e.id,
          title: e.title,
          verified: e.verified,
          disabled: disabled.includes(e.id),
          correct: (byEntry[e.id] || {}).correct || 0,
          incorrect: (byEntry[e.id] || {}).incorrect || 0
        };
      }),
      unanswered: unanswered.results || []
    });
  } catch (e) {
    console.error("管理データの取得に失敗", e);
    return jsonResponse({ error: "db_error" }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!hasDatabase(env)) {
    return jsonResponse({ error: "db_not_configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const entryId = body.entryId;
  if (!AU_KNOWLEDGE.some(function (e) { return e.id === entryId; })) {
    return jsonResponse({ error: "unknown_entry" }, 400);
  }

  try {
    if (body.disabled === true) {
      await env.DB.prepare(
        `INSERT INTO disabled_entries (entry_id, disabled_at, disabled_by)
         VALUES (?, ?, ?)
         ON CONFLICT(entry_id) DO UPDATE SET disabled_at = excluded.disabled_at,
                                             disabled_by = excluded.disabled_by`
      )
        .bind(entryId, new Date().toISOString(), getUserEmail(request))
        .run();
    } else {
      await env.DB.prepare(`DELETE FROM disabled_entries WHERE entry_id = ?`)
        .bind(entryId)
        .run();
    }
    return jsonResponse({ ok: true, entryId: entryId, disabled: body.disabled === true });
  } catch (e) {
    console.error("回答停止設定の更新に失敗", e);
    return jsonResponse({ error: "db_error" }, 500);
  }
}
