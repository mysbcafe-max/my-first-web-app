# CLAUDE.md — Web事業部の開発規約

このリポジトリは GitHub Pages で公開する Web サイト。バーチャルカンパニーの「Web事業部」。
会社全体の運営ルールは本社リポジトリ [New-Adventure](https://github.com/mysbcafe-max/New-Adventure) の `company/` を参照。

## 技術方針

- 静的サイト(HTML/CSS/JS のみ)。ビルドツールやフレームワークは導入しない
- 外部 CDN に依存せず、スタイルとスクリプトはリポジトリ内に置く
- スマホでも見られるようレスポンシブにする

## 開発ルール

- 変更は `claude/` プレフィックスのブランチで行い、PR 経由で main に入れる
- main への直接 push はしない(main = 公開中のサイト)
- PR には「何を変えたか」と「確認方法(どのページをどう見るか)」を書く
- コミットメッセージは日本語でよい

## タスクの受け取り方

- 本社リポジトリの `company/BACKLOG.md` と、このリポジトリの Issue がタスクの入口
