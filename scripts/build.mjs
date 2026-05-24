// scripts/build.mjs
// feeds.json に書かれた RSS をすべて取得し、public/data.json を生成する。
// 1つのフィードが落ちていても全体は止まらず、生きているフィードだけで出力する。
//
// 環境変数 ANTHROPIC_API_KEY が設定されている場合は、Claude Haiku で
//   ・英語記事の日本語タイトル化
//   ・日本語の3行要約
//   ・部門タグ付け（営業 / 内部事務 / 指令塔・第2営業 / サイン / EC）
//   ・「AIに仕事を奪われる」系のネガティブ記事の除外
// を行う。キーが無くても従来どおり動作する（AI処理をスキップするだけ）。

import Parser from 'rss-parser';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ---- 基本設定 ----
const FEEDS_PATH = 'feeds.json';
const OUT_PATH = 'public/data.json';
// 前回公開済みの data.json。AI処理済みの記事をキャッシュとして再利用するために読む。
// （リポジトリやユーザー名を変えた場合はここも変更すること）
const PUBLISHED_URL = 'https://snowdrop-lab.github.io/ai-news-board/data.json';

const MAX_ITEMS = 200;     // 出力する記事の上限（全体）
const MAX_PER_FEED = 15;   // 1フィードあたりの最大件数（特定フィードの独占を防ぐ）
const MAX_AGE_DAYS = 45;   // これより古い記事は除外（日付不明の記事は残す）
const SNIPPET_LEN = 220;   // 概要テキストの最大文字数

// ---- AI設定 ----
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_ENABLED = API_KEY.length > 0;
const AI_MODEL = 'claude-haiku-4-5';
const AI_BATCH = 8;        // 1リクエストでまとめて処理する記事数
const DEPARTMENTS = ['営業', '内部事務', '指令塔・第2営業', 'サイン', 'EC'];

const parser = new Parser({
  timeout: Number(process.env.FEED_TIMEOUT_MS) || 20000,
  headers: { 'User-Agent': 'ai-news-board/1.0 (internal news aggregator)' },
});

// HTMLタグと主要なエンティティを除去してプレーンテキスト化する
function stripHtml(input = '') {
  return String(input)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// 文字数で切り詰める（語の途中で切らない）
function clip(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

// RSSアイテムから日付を取り出す
function toDate(item) {
  const raw = item.isoDate || item.pubDate || item.date;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// =============================================================
//  AI処理（翻訳・要約・部門タグ・除外判定）
// =============================================================

// Claude への指示。部門の定義と判定ルール。バッチをまたいで使い回す。
const AI_SYSTEM = `あなたは社内向け「AI情報ボード」の編集アシスタントです。
渡されたニュース記事それぞれについて、社内の人が業務目線でひと目で把握できるように整理してください。

【部門の定義】記事が実務上どの部門に役立つかを判定します。
- 営業: 営業手法、商談・提案、顧客対応、見積・受注、マーケティング
- 内部事務: Excel/Word/PowerPoint、Microsoft Copilot、業務効率化の小技、営業事務、経理・会計
- 指令塔・第2営業: 配送・物流、在庫管理、倉庫管理、サプライチェーン、ルート最適化
- サイン: Adobe製品（Illustrator/Photoshop/Firefly等）、デザイン系AI、画像生成、屋外広告物、看板・本設サイン、印刷・大判出力
- EC: ネット通販、ECサイト運営、オンライン販売、Shopify等のECプラットフォーム

【除外ルール】次に該当する記事は exclude を true にします。
- 記事の主題が「AIに仕事を奪われる」「この職業はなくなる」等、人間の雇用喪失への不安をあおる論調のもの
- AI起因の人員削減・レイオフをセンセーショナルに扱ったもの
ただし、業務を自動化・効率化するツールの紹介、制度・規制、製品発表などは除外しません（exclude は false）。
判定は控えめに行い、明確に不安をあおる記事だけを除外してください。

【出力】各記事について次のキーを持つJSONオブジェクトを作り、入力と同じ順序の配列で返します。
- "i": 入力で渡された番号（整数）
- "titleJa": 自然な日本語のタイトル（英語記事は翻訳、日本語記事はそのまま簡潔に整える）
- "summaryJa": 日本語の要約。3行程度、各行は短く、業務目線で何が分かるかを書く。改行は \\n で区切る
- "departments": 上記5部門のうち該当するものだけの配列。明確に当てはまる部門のみを入れ、特定部門に紐づかない一般的なAIニュースは空配列 [] にする
- "exclude": 除外ルールに該当すれば true、それ以外は false

JSON配列のみを出力し、前置きの文章やコードフェンスは付けないこと。`;

// 1バッチ分の記事を Claude API に投げる
async function callClaude(articles) {
  const userMsg = '次の記事を処理してください:\n' + JSON.stringify(articles);
  const body = {
    model: AI_MODEL,
    max_tokens: 4096,
    // system はバッチごとに同一なので prompt caching を効かせる
    system: [{ type: 'text', text: AI_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMsg }],
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`API ${res.status}: ${t.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = (data.content || [])
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  // 念のためコードフェンスが付いていても外せるようにする
  const clean = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  return JSON.parse(clean);
}

// 1バッチを処理。失敗時は数回まで再試行し、それでもダメなら null を返す
// （呼び出し側でフォールバック値のまま進める）。
async function processBatch(articles) {
  const waits = [0, 3000, 12000]; // 試行ごとの待ち時間（ミリ秒）
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await new Promise((r) => setTimeout(r, waits[attempt]));
    try {
      const out = await callClaude(articles);
      if (Array.isArray(out)) return out;
      throw new Error('配列が返らなかった');
    } catch (err) {
      console.warn(`  AIバッチ失敗 (${attempt + 1}/${waits.length}): ${err.message}`);
    }
  }
  return null;
}

// 前回公開済みの data.json を取得し、link をキーにAI処理済みフィールドを引けるMapにする
async function loadCache() {
  try {
    const res = await fetch(PUBLISHED_URL, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const map = new Map();
    for (const it of json.items || []) {
      if (it.link && it.titleJa) {
        map.set(it.link, {
          titleJa: it.titleJa,
          summaryJa: it.summaryJa || '',
          departments: Array.isArray(it.departments) ? it.departments : [],
        });
      }
    }
    console.log(`キャッシュ読込: 既処理 ${map.size} 件を再利用可能`);
    return map;
  } catch (err) {
    console.log(`キャッシュなし（初回または取得失敗: ${err.message}）`);
    return new Map();
  }
}

// items 配列にAI処理（翻訳・要約・部門タグ・除外）を適用して返す
async function applyAI(items) {
  const cache = await loadCache();

  // 未処理（キャッシュに無い）記事のインデックスを集める
  const todo = [];
  items.forEach((it, idx) => {
    const c = cache.get(it.link);
    if (c) {
      it.titleJa = c.titleJa || it.title;
      it.summaryJa = c.summaryJa || '';
      it.departments = c.departments || [];
    } else {
      todo.push(idx);
    }
  });
  console.log(`AI処理対象: ${todo.length} 件（残り ${items.length - todo.length} 件はキャッシュ再利用）`);

  // 新着分をバッチで処理
  for (let s = 0; s < todo.length; s += AI_BATCH) {
    const idxBatch = todo.slice(s, s + AI_BATCH);
    const payload = idxBatch.map((idx, k) => ({
      i: k,
      title: items[idx].title,
      summary: items[idx].summary,
      lang: items[idx].lang,
    }));
    const result = await processBatch(payload);
    if (!result) {
      console.warn('  → このバッチはフォールバック値のまま進めます');
      continue;
    }
    for (const r of result) {
      const idx = idxBatch[r && r.i];
      if (idx == null) continue;
      const it = items[idx];
      if (r.titleJa) it.titleJa = String(r.titleJa);
      if (r.summaryJa) it.summaryJa = String(r.summaryJa);
      if (Array.isArray(r.departments)) {
        it.departments = r.departments.filter((d) => DEPARTMENTS.includes(d));
      }
      if (r.exclude === true) it._exclude = true;
    }
    console.log(`  AI: ${Math.min(s + AI_BATCH, todo.length)}/${todo.length} 件 完了`);
  }

  // 除外フラグの立った記事（ネガティブ記事）を取り除く
  const before = items.length;
  const kept = items.filter((it) => !it._exclude);
  kept.forEach((it) => delete it._exclude);
  const excludedCount = before - kept.length;
  if (excludedCount > 0) console.log(`除外（ネガティブ記事）: ${excludedCount} 件`);

  return { items: kept, excludedCount };
}

// =============================================================
//  メイン処理
// =============================================================

async function main() {
  const feeds = JSON.parse(await readFile(FEEDS_PATH, 'utf8'));
  const collected = [];
  const sources = [];

  for (const feed of feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);
      let count = 0;
      for (const item of parsed.items || []) {
        const link = (item.link || '').trim();
        if (!link) continue;
        const date = toDate(item);
        collected.push({
          title: stripHtml(item.title || '(無題)'),
          link,
          source: feed.name,
          category: feed.category || 'その他',
          lang: feed.lang || 'en',
          priority: feed.priority === 'high' ? 'high' : 'normal',
          summary: clip(
            stripHtml(item.contentSnippet || item.content || item.summary || ''),
            SNIPPET_LEN
          ),
          publishedAt: date ? date.toISOString() : null,
        });
        count++;
      }
      sources.push({ name: feed.name, category: feed.category, ok: true, count });
      console.log(`OK    ${feed.name} — ${count} 件`);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      sources.push({ name: feed.name, category: feed.category, ok: false, error: msg });
      console.warn(`FAIL  ${feed.name} — ${msg}`);
    }
  }

  // 重複記事を除去
  //  (1) 同じURL
  //  (2) タイトルがほぼ一致（記号・空白・大文字小文字を無視して比較）
  //      → 同じニュースが複数のRSSに載った場合、先に取得した1件だけ残す
  const seenLinks = new Set();
  const seenTitles = new Set();
  const normTitle = (t) =>
    String(t).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let items = collected.filter((it) => {
    if (seenLinks.has(it.link)) return false;
    const tkey = normTitle(it.title);
    if (tkey.length >= 8 && seenTitles.has(tkey)) return false;
    seenLinks.add(it.link);
    if (tkey.length >= 8) seenTitles.add(tkey);
    return true;
  });

  // 古すぎる記事を除外（日付不明は残す）
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  items = items.filter(
    (it) => !it.publishedAt || new Date(it.publishedAt).getTime() >= cutoff
  );

  // 新しい順に並べる（日付不明は末尾へ）
  items.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });

  // 1フィードあたりの件数を制限する
  //  新しい順に走査し、各ソースが MAX_PER_FEED 件に達したらそれ以上は捨てる。
  const perFeed = {};
  items = items.filter((it) => {
    const n = (perFeed[it.source] || 0) + 1;
    if (n > MAX_PER_FEED) return false;
    perFeed[it.source] = n;
    return true;
  });

  items = items.slice(0, MAX_ITEMS);

  // --- AI処理前に、全件へフォールバック値を入れておく ---
  //   （キー未設定・バッチ失敗でも UI が必ず表示できるようにする）
  for (const it of items) {
    it.titleJa = it.title;   // 翻訳できなければ原題のまま
    it.summaryJa = '';       // 要約できなければ空（UI側は summary を代用）
    it.departments = [];     // タグ付けできなければ無し
  }

  // --- AI処理（キーがある時だけ）---
  let excludedCount = 0;
  if (AI_ENABLED) {
    console.log(`\nAI処理を開始（モデル: ${AI_MODEL}）`);
    const r = await applyAI(items);
    items = r.items;
    excludedCount = r.excludedCount;
  } else {
    console.log('\nANTHROPIC_API_KEY 未設定 — AI処理をスキップ（翻訳・要約・部門タグなし）');
  }

  const data = {
    generatedAt: new Date().toISOString(),
    feedCount: feeds.length,
    okCount: sources.filter((s) => s.ok).length,
    itemCount: items.length,
    aiEnabled: AI_ENABLED,        // UIが「AI処理済みか」を判定するために使う
    departments: DEPARTMENTS,     // 部門フィルターの基準リスト
    excludedCount,                // 除外したネガティブ記事の件数
    sources,
    items,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(data, null, 2), 'utf8');

  console.log(
    `\n完了: ${OUT_PATH}（記事 ${items.length} 件 / 成功フィード ${data.okCount}/${feeds.length}` +
    (AI_ENABLED ? ' / AI処理: 有効' : ' / AI処理: 無効') + '）'
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('致命的エラー:', err);
    process.exit(1);
  });
