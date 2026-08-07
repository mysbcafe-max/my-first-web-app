-- au サービス案内チャットボット用 D1 データベーススキーマ
--
-- 適用コマンド(初回のみ):
--   npx wrangler d1 execute au-chatbot --remote --file=./schema.sql
--
-- 詳細な手順は docs/cloudflare-setup.md を参照。

-- 回答への正誤フィードバック
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  question    TEXT NOT NULL,
  answer      TEXT,
  entry_ids   TEXT,             -- 根拠にしたナレッジベース項目 id(カンマ区切り)
  verdict     TEXT NOT NULL,    -- 'correct' | 'incorrect'
  note        TEXT,
  user_email  TEXT              -- Cloudflare Access が渡す認証済みメールアドレス
);

CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback (created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_verdict    ON feedback (verdict);

-- ナレッジベースに根拠がなく回答できなかった質問(次に登録すべき項目の入口)
CREATE TABLE IF NOT EXISTS unanswered (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  question    TEXT NOT NULL,
  user_email  TEXT
);

CREATE INDEX IF NOT EXISTS idx_unanswered_created_at ON unanswered (created_at);

-- 誤りと判断され、回答に使うのを停止した項目(全社に即時反映される)
CREATE TABLE IF NOT EXISTS disabled_entries (
  entry_id    TEXT PRIMARY KEY,
  disabled_at TEXT NOT NULL,
  disabled_by TEXT
);
