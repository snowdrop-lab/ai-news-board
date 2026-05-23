# AI 情報ボード（社内向け）

AI 関連の RSS を **1日1回自動収集**して、社内の誰でも見られる Web ページに一覧表示するツールです。
サーバー不要・無料で動きます（GitHub の無料枠のみ使用）。

---

## しくみ（30秒で理解）

```
毎朝6:17ごろ ─▶ GitHub Actions が feeds.json の RSS を全部取得
            ─▶ scripts/build.mjs が data.json にまとめる
            ─▶ public/ を GitHub Pages として公開
社員は公開URLを見るだけ
```

ターミナルも git コマンドも不要。すべてブラウザ上の操作で完結します。

---

## セットアップ手順

### 1. リポジトリを作る
1. GitHub にログイン → 右上「＋」→ **New repository**
2. 名前は `ai-news-board` など任意。**Private でも Public でもOK**
   （Private でも GitHub Pages は公開URLになります。完全非公開にしたい場合は末尾の注意を参照）
3. 「Create repository」

### 2. ファイルをアップロードする
1. 作ったリポジトリの画面で **Add file ▾ → Upload files**
2. このフォルダの中身を**フォルダごとドラッグ&ドロップ**
   （`.github` フォルダも忘れずに。隠しフォルダなので Mac/Win のエクスプローラ設定で表示しておく）
3. 下の「Commit changes」をクリック

アップロードするもの:
```
.github/workflows/update.yml   ← 毎日の自動実行設定
scripts/build.mjs              ← RSS収集スクリプト
public/index.html              ← 表示ページ
feeds.json                     ← 取得元リスト（あとで編集する）
package.json
.gitignore
README.md
```

### 3. GitHub Pages を有効化する
1. リポジトリの **Settings → Pages**
2. **Source** を **「GitHub Actions」** に変更（プルダウン1つ選ぶだけ）

### 4. 初回実行する
1. リポジトリの **Actions** タブ
2. （初回は緑のボタンで Actions を有効化）
3. 左の「AI News 更新」→ 右の **Run workflow** ボタンを押す
4. 1〜2分で完了。Settings → Pages に表示される **URL** が情報ボードです

以降は毎朝 6:17 ごろに自動更新されます。社員にはこの URL を共有してください。

---

## 取得元（RSS）の編集

`feeds.json` を編集するだけです。GitHub の画面上で直接編集（鉛筆アイコン）できます。

```json
{
  "name": "表示名",
  "url":  "RSSフィードのURL",
  "category": "研究 / 企業ブログ / ニュース / 国内 など自由",
  "lang": "ja または en",
  "priority": "high または normal"
}
```

- 追加: 上記の形式で1ブロック足す
- 削除: 不要なブロックを消す
- `priority` を `"high"` にすると、そのソースの記事に「重点」バッジが付きます（重要な情報源を見分けやすくするため。省略時は `normal` 扱い）
- `category` はページ上部の絞り込みチップに自動反映されます。自由に名前を付け替えてOKです
- **URLが間違っていたり配信停止でも、そのフィードだけスキップ**され全体は止まりません
  （どれが失敗したかはページ下部「ソースの取得状況」で確認できます）

> 同梱の URL は一般的なものですが、配信状況は変わります。
> 初回実行後に「ソースの取得状況」を見て、失敗しているものは URL を直すか削除してください。

---

## 調整できる項目（任意）

| 変えたいこと | ファイル | 場所 |
|---|---|---|
| 更新時刻 | `.github/workflows/update.yml` | `cron: '17 21 * * *'`（UTC表記。21:17 = JST 6:17） |
| 記事の表示件数 | `scripts/build.mjs` | `MAX_ITEMS` |
| 何日前まで載せるか | `scripts/build.mjs` | `MAX_AGE_DAYS` |
| 見た目（色・フォント） | `public/index.html` | 先頭の `<style>` 内 `:root` |

---

## 注意点

- **公開範囲**: GitHub Pages の URL は、URL を知っていれば誰でも見られます。社内限定にしたい場合は
  Cloudflare Access などのアクセス制限をかけるか、社内ネットワーク内ホスティングに載せ替えてください。
- **スケジュールのずれ**: GitHub Actions の定時実行は、混雑時に数十分遅れることがあります（仕様）。
  急ぎのときは Actions タブの「Run workflow」で手動実行できます。
- 現状は RSS のみ。X（Twitter）連携や AI による要約・重要度付けは次の段階で追加できます。
