# my-first-web-app — Web事業部

バーチャルカンパニー **New Adventure** の公式サイトです。
本社: [New-Adventure](https://github.com/mysbcafe-max/New-Adventure)

## 公開 URL

https://mysbcafe-max.github.io/my-first-web-app/

## サイトの内容

会社の入口として、次の3つを載せています。

1. **いま作っているもの** — 事業ごとの現在地(公開中 / 開発中 / 検討中)
2. **どう運営しているか** — 担当・記録・お金・公開の方針
3. **のぞいてみる** — 各リポジトリへのリンク

完成しているように見せることはせず、開発中のものは開発中と明記しています。

## 構成

| ファイル | 内容 |
|---|---|
| `index.html` | トップページ |
| `css/style.css` | スタイル(ライト/ダーク両対応) |
| `favicon.svg` | ファビコン |

ビルドツールは使っていません。`index.html` をブラウザで開けばそのまま確認できます。

## 開発の進め方

1. やってほしいことを Issue に書く(または本社のバックログに追記)
2. Claude がブランチを切って実装し、Pull Request を出す
3. オーナーが確認してマージすると、GitHub Pages に自動反映される

開発規約は [CLAUDE.md](CLAUDE.md) を参照。

## 内容を更新するとき

サイトに載せている事業の状態(開発中/公開中など)は手書きです。
事業の状況が変わったら `index.html` の該当箇所と、フッターの `Last updated` を更新してください。
