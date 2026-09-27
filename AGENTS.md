# Tsuri Reco（AGENTS.md：このアプリ専用のルール）

共通ルールは `ai-rules/CODING_RULES.md`（正本 `hirokode/ai-rules` のコピー）。
このファイルには「このアプリにしか当てはまらないこと」だけを書く。
仕様の詳細は `REQUIREMENTS.md`。

## アプリの概要

友達ごとの「共有アルバム」に釣果（写真・位置・日時・魚種・サイズ等）を記録し、地図と一覧で振り返る PWA。
アルバムのメンバー（自分＋友達）だけが閲覧・登録・編集できる。
データモデルは最初から「アルバム＝N人のメンバー」。MVP は UI を2人前提にしているだけ。

## 構成

```
スマホのブラウザ ── GitHub Pages（index.html / app.js / style.css / config.js / sw.js）
                      │ fetch（POST, Content-Type: text/plain）
                      ▼
               GAS ウェブアプリ（gas/）
                      │
                      ├─ スプレッドシート（albums / members / catches）
                      └─ Google Drive（アルバムごとの写真フォルダ）
```

- 画面は GitHub Pages（`https://hirokode.github.io/tsuri-reco/`）。`google.script.run` は使えないので `fetch` で `/exec` を呼ぶ
- `config.js` の `API_URL`（`/exec` のURL）は画面が読むため公開される。**共通ルール §6 の例外として、この値だけはコミットしてよい**
- ライブラリ（Leaflet など）は CDN 読み込み。ビルド工程は作らない

## 認証（招待トークン方式）

- **合言葉方式（NEW_APP.md）は使わない。** リポジトリが Public なので、画面側に共通の秘密を置かない
- アルバムのメンバーごとにトークン（ランダム文字列）を発行し、招待リンク `?invite=<トークン>` で配る
- 画面はトークンを localStorage に保存し、API を呼ぶたびに送る
- GAS は毎リクエストでトークンを検証し、**そのトークンが属するアルバムのデータだけ**を返す・変更する
- トークンはスプレッドシートの members シートにだけある。コード・コミット・チャットに実際の値を書かない

## ファイル構成

| ファイル | 役割 |
|---|---|
| index.html | 画面の骨組み |
| app.js | 画面の処理 |
| style.css | 見た目 |
| config.js | GAS の `/exec` URL（API_URL）だけを書く |
| sw.js / manifest.json / icons/ | PWA（ホーム画面追加・画像キャッシュ） |
| gas/ | Apps Script（clasp の rootDir） |
| .github/workflows/deploy-gas.yml | gas/ の変更を main に入れると自動で push＋既存デプロイ上書き |
| ai-rules/CODING_RULES.md | 共通ルールのコピー |

## デプロイ

- 画面：main に入ると GitHub Pages に1〜2分で反映
- サーバー：`gas/` の変更が main に入ると GitHub Actions が `clasp push` → `clasp deploy -i <本番デプロイID>` を実行
- 手元（PC）で直接やる場合：`cd "C:\Users\hiro2\dev\apps\tsuri-reco\gas"; clasp push -f; if ($?) { clasp deploy -i <デプロイID> -d "<変更メモ>" }`
- デプロイIDなどの実際の値は `アプリURL.txt`（.gitignore 済み）と GitHub Secrets にだけある
- 画面（app.js など）を変えたら `sw.js` の `CACHE_VERSION` を上げる（古い画面がキャッシュに残らないように）

## スクリプトプロパティ

どちらも初回リクエスト時に GAS が自動で作って保存する。手で設定する必要はない。

| 名前 | 中身 |
|---|---|
| SPREADSHEET_ID | データ保存用スプレッドシートのID |
| ROOT_FOLDER_ID | 写真保存用 Drive フォルダ（アルバム別フォルダの親）のID |

## スプレッドシートの構成

| シート | 列 |
|---|---|
| albums | album_id, name, created_at, drive_folder_id |
| members | member_id, album_id, display_name, token, joined_at |
| catches | catch_id, album_id, caught_at, lat, lng, place_name, species, size_cm, weight_g, count, angler_member_id, tide_name, tide_events, method, bait, memo, photo_ids, created_by, created_at, updated_by, updated_at, deleted |

- ID は UUID。削除は論理削除（deleted=true）
- tide_events・photo_ids は JSON 文字列

## このアプリ固有のルール

- 列を増やすときは `gas/` のヘッダー定義と既存シートの見出し行の両方を更新する（既存の列の順番は変えない）
- 写真の表示URLの組み立ては app.js の1つの関数にまとめる（将来の保存先移行に備えるため）
- 画面とサーバーを同時に変えるときは、新しい画面が古いサーバーを呼んでも壊れないように作る
