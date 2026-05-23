// scripts/build.mjs
// feeds.json に書かれた RSS をすべて取得し、public/data.json を生成する。
// 1つのフィードが落ちていても全体は止まらず、生きているフィードだけで出力する。

import Parser from 'rss-parser';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const FEEDS_PATH = 'feeds.json';
const OUT_PATH = 'public/data.json';

const MAX_ITEMS = 200;     // 出力する記事の上限（全体）
const MAX_PER_FEED = 15;   // 1フィードあたりの最大件数（特定フィードの独占を防ぐ）
const MAX_AGE_DAYS = 45;   // これより古い記事は除外（日付不明の記事は残す）
const SNIPPET_LEN = 220;   // 概要テキストの最大文字数

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
  //  → arXiv のような大量フィードが表示枠を独占するのを防ぎ、
  //    ニュースや日本語記事も枠に入るようにする。
  const perFeed = {};
  items = items.filter((it) => {
    const n = (perFeed[it.source] || 0) + 1;
    if (n > MAX_PER_FEED) return false;
    perFeed[it.source] = n;
    return true;
  });

  items = items.slice(0, MAX_ITEMS);

  const data = {
    generatedAt: new Date().toISOString(),
    feedCount: feeds.length,
    okCount: sources.filter((s) => s.ok).length,
    itemCount: items.length,
    sources,
    items,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(data, null, 2), 'utf8');

  console.log(
    `\n完了: ${OUT_PATH}（記事 ${items.length} 件 / 成功フィード ${data.okCount}/${feeds.length}）`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('致命的エラー:', err);
    process.exit(1);
  });
