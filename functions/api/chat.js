// POST /api/chat — 生成AI(Claude API)による回答生成
//
// このファイルは Cloudflare 上で動くサーバー側コードです。ブラウザには配信されません。
// ANTHROPIC_API_KEY はここでしか読まれないため、鍵が利用者に漏れることはありません。
//
// 「出典必須・憶測禁止」を仕組みで保証している箇所:
//  1. モデルに渡す材料はナレッジベースの本文だけ(出典URLは渡さない)
//  2. モデルには根拠にした項目の id だけを返させ、URL はサーバーが id から引く
//     → 存在しない出典URLをモデルが作文することが構造的に不可能
//  3. 有効な id が1つも返らなかった回答は、サーバー側で強制的に「回答不可」に倒す

import { AU_KNOWLEDGE, buildKnowledgeContext } from "../../chatbot/data/knowledge.js";
import { getDisabledEntryIds, jsonResponse, getUserEmail } from "./_lib.js";

const DEFAULT_MODEL = "claude-haiku-4-5";

const SYSTEM_RULES = `あなたは au のサービスについて社内スタッフに案内する、社内向けチャットボットです。

## 絶対に守るルール
1. 下記「ナレッジベース」に書かれている情報だけを根拠に回答してください。ナレッジベースに書かれていない情報は、あなたが一般知識として知っていても回答してはいけません。
2. 回答の根拠にした項目の id を source_ids に必ず入れてください。source_ids が空の回答をしてはいけません。
3. 質問に答える根拠がナレッジベースにない場合は answerable を false にし、answer には「回答できない」ことと理由を簡潔に書いてください。推測や一般論で補ってはいけません。
4. 曖昧な表現(「おそらく」「〜だと思います」「一般的には」)を使わないでください。ナレッジベースから断定できることだけを書きます。
5. ナレッジベースに書かれていない数値・条件・期間・金額を、自分で補ってはいけません。
6. 質問が au 以外のブランドや他社のサービスについてのものである場合も、ナレッジベースに根拠がなければ answerable を false にしてください。

## 回答スタイル
- 日本語の丁寧語で、2〜4文程度の簡潔な案内文にしてください。
- 出典のURLやリンクを answer 本文に書かないでください。出典はシステムが source_ids から自動的に付けます。
- 挨拶や前置き(「ご質問ありがとうございます」など)は不要です。用件から書き始めてください。`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    answerable: {
      type: "boolean",
      description: "ナレッジベースだけを根拠に回答できる場合は true、根拠がない場合は false"
    },
    answer: {
      type: "string",
      description: "回答本文。answerable が false の場合は回答できない理由"
    },
    source_ids: {
      type: "array",
      items: { type: "string" },
      description: "根拠にしたナレッジベース項目の id。answerable が false の場合は空配列"
    }
  },
  required: ["answerable", "answer", "source_ids"],
  additionalProperties: false
};

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    // 鍵が未設定 = 第2段階が未セットアップ。フロントはキーワード検索に自動で切り替わる。
    return jsonResponse({ error: "ai_not_configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return jsonResponse({ error: "question_required" }, 400);
  }
  if (question.length > 1000) {
    return jsonResponse({ error: "question_too_long" }, 400);
  }

  // 誤答として停止中の項目は、そもそもモデルに渡さない
  const disabled = await getDisabledEntryIds(env);
  const activeEntries = AU_KNOWLEDGE.filter(function (e) {
    return !disabled.includes(e.id);
  });

  if (activeEntries.length === 0) {
    return jsonResponse({
      answerable: false,
      answer: "現在、参照できるナレッジベース項目がありません。管理者にお問い合わせください。",
      sources: [],
      entryIds: [],
      mode: "ai"
    });
  }

  const systemText =
    SYSTEM_RULES +
    "\n\n## ナレッジベース\n\n" +
    buildKnowledgeContext(activeEntries);

  let apiResponse;
  try {
    apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || DEFAULT_MODEL,
        max_tokens: 2048,
        // ナレッジベースは毎回同じ内容なので、キャッシュ対象にして入力コストを下げる。
        // (ナレッジベースが一定量を超えるとキャッシュが効き始めます。docs/cloudflare-setup.md 参照)
        system: [
          { type: "text", text: systemText, cache_control: { type: "ephemeral" } }
        ],
        output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        messages: [{ role: "user", content: question }]
      })
    });
  } catch (e) {
    return jsonResponse({ error: "upstream_unreachable" }, 502);
  }

  if (!apiResponse.ok) {
    const detail = await apiResponse.text();
    console.error("Claude API error", apiResponse.status, detail);
    return jsonResponse(
      { error: "upstream_error", status: apiResponse.status },
      apiResponse.status === 429 ? 429 : 502
    );
  }

  const message = await apiResponse.json();

  // 安全性による拒否。content が空になるため、先に stop_reason を見る
  if (message.stop_reason === "refusal") {
    return jsonResponse({
      answerable: false,
      answer: "この質問には回答できません。内容を変えて再度お試しください。",
      sources: [],
      entryIds: [],
      mode: "ai"
    });
  }

  const textBlock = (message.content || []).find(function (b) {
    return b.type === "text";
  });
  if (!textBlock) {
    return jsonResponse({ error: "empty_response" }, 502);
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    return jsonResponse({ error: "unparsable_response" }, 502);
  }

  // ここが要: モデルが返した id を実データと突き合わせ、実在する項目だけを採用する。
  // 出典URLはこの突き合わせの結果から引くので、モデルは出典を捏造できない。
  const matched = (parsed.source_ids || [])
    .map(function (id) {
      return activeEntries.find(function (e) {
        return e.id === id;
      });
    })
    .filter(Boolean);

  // 根拠なしの回答は、モデルが answerable=true と主張していても通さない
  if (!parsed.answerable || matched.length === 0) {
    return jsonResponse({
      answerable: false,
      answer:
        typeof parsed.answer === "string" && parsed.answer && !parsed.answerable
          ? parsed.answer
          : "この質問に対応する確認済みの情報がナレッジベースに登録されていないため、回答できません。",
      sources: [],
      entryIds: [],
      mode: "ai"
    });
  }

  const sources = [];
  matched.forEach(function (entry) {
    entry.sources.forEach(function (s) {
      if (!sources.some(function (x) { return x.url === s.url; })) sources.push(s);
    });
  });

  return jsonResponse({
    answerable: true,
    answer: parsed.answer,
    sources: sources,
    entryIds: matched.map(function (e) { return e.id; }),
    unverified: matched.some(function (e) { return !e.verified; }),
    model: message.model,
    usage: message.usage,
    user: getUserEmail(request),
    mode: "ai"
  });
}
