// Pages Functions 共通ヘルパー
// 先頭が _ のファイルは URL に公開されません(ルーティング対象外)。

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

// Cloudflare Access が認証済み利用者のメールアドレスをこのヘッダで渡してくる。
// Access 未設定の環境では null になる(その場合フィードバックは匿名で記録される)。
export function getUserEmail(request) {
  return request.headers.get("Cf-Access-Authenticated-User-Email") || null;
}

// D1 が未設定でもチャット機能自体は動かし続ける。
// (セットアップ途中や、静的ホスティングでの動作確認のため)
export function hasDatabase(env) {
  return Boolean(env.DB);
}

export async function getDisabledEntryIds(env) {
  if (!hasDatabase(env)) return [];
  try {
    const result = await env.DB.prepare(
      "SELECT entry_id FROM disabled_entries"
    ).all();
    return (result.results || []).map(function (row) {
      return row.entry_id;
    });
  } catch (e) {
    console.error("disabled_entries の取得に失敗", e);
    return [];
  }
}
