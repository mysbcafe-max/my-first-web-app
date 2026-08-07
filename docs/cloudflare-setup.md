# Cloudflare セットアップ手順(経営者向け)

au サービス案内チャットボットを Cloudflare 上で公開し、社内スタッフだけがアクセスできるようにする手順です。
**所要時間の目安: 40〜60分。** 上から順にやれば完了します。

## この手順で実現すること

| やりたいこと | 使うもの | 費用 |
| --- | --- | --- |
| サイトの公開 | Cloudflare Pages | 無料 |
| 社内スタッフだけに限定 | Cloudflare Access | **50人まで無料** |
| 生成AI(APIキーを隠して呼ぶ) | Pages Functions | 無料枠内 |
| フィードバックの全社集約 | Cloudflare D1 | 無料枠内 |
| Claude API の利用 | Anthropic | **従量課金(唯一の有料項目)** |

---

## ステップ0: 必要なアカウント(2つ)

1. **Cloudflare アカウント** — https://dash.cloudflare.com/sign-up (無料、クレジットカード不要)
2. **Anthropic アカウント** — https://console.anthropic.com/ (APIキー発行と支払い設定に必要)

どちらも**経営者名義**で作成してください。退職・異動で使えなくなるのを防ぐためです。

---

## ステップ1: Anthropic の APIキーを発行し、上限を設定する

1. https://console.anthropic.com/ にログイン
2. **Billing** から支払い方法を登録し、初期クレジット(例: $20 ≒ 3,000円)を購入
3. ⚠️ **重要: Billing → Usage limits で月額の上限を設定してください。**
   想定は月1,000〜5,000円程度なので、まずは **$20〜40(3,000〜6,000円)** 程度を上限にしておくと、
   設定ミスや想定外の利用があっても被害が上限で止まります
4. **API keys → Create Key** でキーを発行し、控えておく(`sk-ant-...` で始まる文字列)

> 🔑 このキーは**絶対に GitHub や資料に貼らないでください。** ステップ4で Cloudflare にだけ登録します。

---

## ステップ2: Cloudflare Pages でサイトを公開する

1. Cloudflare ダッシュボード → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. GitHub と連携し、`mysbcafe-max/my-first-web-app` リポジトリを選択
3. ビルド設定は**すべて空のまま**にします(ビルド不要の静的サイトのため):
   - Framework preset: **None**
   - Build command: **(空欄)**
   - Build output directory: **`/`**
4. **Save and Deploy** を押す
5. 数分待つと `https://au-chatbot-xxxx.pages.dev` のような URL が発行されます

この時点でサイトは見られますが、まだ**全世界に公開**の状態です。ステップ5で閉じます。

---

## ステップ3: フィードバック集約用データベース(D1)を作る

Cloudflare ダッシュボード → **Storage & Databases** → **D1** → **Create database**

- データベース名: `au-chatbot`

作成後、そのデータベースの **Console** タブを開き、リポジトリの
[`schema.sql`](../schema.sql) の中身をコピーして貼り付け、実行してください。
3つのテーブル(`feedback` / `unanswered` / `disabled_entries`)が作られます。

次に、Pages プロジェクトに接続します:

**Workers & Pages** → 作ったプロジェクト → **Settings** → **Bindings** → **Add** → **D1 database**

- Variable name: **`DB`** ← この名前でないと動きません
- D1 database: `au-chatbot`

---

## ステップ4: APIキーを Cloudflare に登録する

**Settings** → **Variables and Secrets** → **Add**

| 種別 | 変数名 | 値 |
| --- | --- | --- |
| **Secret**(暗号化) | `ANTHROPIC_API_KEY` | ステップ1で発行したキー |
| Text(平文でOK) | `CLAUDE_MODEL` | `claude-haiku-4-5` |

> `ANTHROPIC_API_KEY` は必ず **Secret** を選んでください。Text にすると管理画面から読めてしまいます。

`CLAUDE_MODEL` は回答品質を上げたくなったら `claude-sonnet-5` に変更できます(コストは約3倍)。

登録後、**Deployments → 最新のデプロイ → Retry deployment** で再デプロイすると反映されます。

---

## ステップ5: 社内スタッフだけに限定する(Cloudflare Access)

ここが「社内限定」を実現する部分です。

1. ダッシュボード左メニュー → **Zero Trust**(初回はチーム名の設定を求められます。無料プランを選択)
2. **Access** → **Applications** → **Add an application** → **Self-hosted**
3. 設定:
   - Application name: `au チャットボット`
   - Session Duration: `24 hours` 程度
   - Public hostname: ステップ2で発行された `xxxx.pages.dev` のドメイン
4. **Policies** で誰が入れるかを決めます:
   - Policy name: `社内スタッフ`
   - Action: **Allow**
   - Include: **Emails** を選び、許可するスタッフのメールアドレスを列挙
     (会社ドメインがあるなら **Emails ending in** で `@example.co.jp` とまとめて指定する方が楽です)
5. **Save**

これで、サイトを開くとメールアドレスの入力とワンタイムコードによる認証が求められ、
許可リストにない人は入れなくなります。**`/api/*` も同じ認証で保護されるため、
APIだけを直接叩かれる心配もありません。**

> 💡 認証済みのメールアドレスは、フィードバック記録にも保存されます(誰が誤りを報告したかを追える)。
> 退職者が出た場合は、このポリシーからメールアドレスを削除するだけでアクセスを取り消せます。

---

## ステップ6: GitHub Pages を止める

Cloudflare 側で公開できたので、**全世界に公開されている GitHub Pages は止めます**。
これを忘れると、認証をかけた意味がなくなります。

GitHub リポジトリ → **Settings** → **Pages** → Source を **None** に変更

---

## 動作確認

1. 発行された URL を開く → **メールアドレスの認証画面が出る**(出なければステップ5を見直し)
2. 認証後、チャット画面右上に「**生成AI 回答モード**」と表示される
   - 「キーワード検索モード」と出る場合は、APIキー(ステップ4)が未設定か再デプロイ待ちです
3. 「auの問い合わせ電話番号は?」→ **出典リンク付きの回答**が返る
4. 「今日の天気は?」→ **憶測せず「回答できません」**と返る
5. 👎 を押す → 管理パネルに「全社集計(サーバー保存)を表示しています」と出て件数が反映される
6. 管理パネルで「回答を停止する」→ 別のブラウザで同じ質問をしても回答されない(全社反映の確認)

---

## 運用メモ

### コスト管理
- Anthropic コンソールの **Usage** で日々の利用額を確認できます
- 上限(ステップ1-3)に達すると API が止まるため、請求が青天井になることはありません
- 現状のナレッジベースは小さいため、プロンプトキャッシュはまだ効きません。
  ナレッジベースが一定量(Haiku 4.5 の場合およそ4,096トークン)を超えると自動的にキャッシュが効き始め、
  入力コストが下がります。設定は済んでいるので追加作業は不要です

### 50人の壁
Cloudflare Access の無料枠は **50ユーザーまで**です。51人目は**アクセスできなくなります**(自動課金はされません)。
50人を超える場合は $7/人/月 のプランへの移行が必要です。

### ナレッジベースの更新
`chatbot/data/knowledge.js` を編集する PR を main にマージすると、Cloudflare Pages が自動で再デプロイします。
生成AI・キーワード検索の両方が同じファイルを読むため、更新箇所は1つだけです。
