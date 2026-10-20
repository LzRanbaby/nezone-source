'use strict';
/*
 * nezone 官方源 — a tiny Stremio-protocol stream addon for the nezone app.
 * Resolves tt / kitsu ids to titles, searches Chinese 苹果CMS resource APIs
 * (server-side), and returns direct m3u8/mp4 streams.
 * Zero dependencies. Node 18+.
 */
const http = require('http');

const PORT = process.env.PORT || 7000;
const TMDB_KEY = process.env.TMDB_KEY || '';

// ---- resource APIs (苹果CMS provide/vod) ----
const APIS = [
  { name: '非凡', base: 'http://cj.ffzyapi.com/api.php/provide/vod/' },
  { name: '百度', base: 'https://api.apibdzy.com/api.php/provide/vod/' },
  { name: '量子', base: 'https://cj.lziapi.com/api.php/provide/vod/' },
];

const cache = new Map(); // key -> {at, val}
const CACHE_MS = 10 * 60 * 1000;

async function fetchJSON(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 12000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 nezone-source/1.0', Accept: 'application/json' },
      redirect: 'follow',
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.val;
  const val = await fn();
  if (val != null) cache.set(key, { at: Date.now(), val });
  return val;
}

// ---- title resolution ----
async function cinemetaName(type, tt) {
  const d = await fetchJSON(`https://v3-cinemeta.strem.io/meta/${type}/${tt}.json`);
  return d && d.meta ? d.meta.name : null;
}

async function tmdbZhName(type, tt) {
  if (!TMDB_KEY) return null;
  const d = await fetchJSON(
    `https://api.themoviedb.org/3/find/${tt}?api_key=${TMDB_KEY}&external_source=imdb_id&language=zh-CN`
  );
  if (!d) return null;
  const arr = type === 'movie' ? d.movie_results : d.tv_results;
  const hit = arr && arr[0];
  return hit ? hit.title || hit.name : null;
}

async function kitsuTitles(id) {
  const d = await fetchJSON(`https://kitsu.io/api/edge/anime/${id}`);
  if (!d || !d.data) return {};
  const at = d.data.attributes || {};
  const t = at.titles || {};
  return { en: at.canonicalTitle || t.en, ja: t.ja_jp };
}

async function bangumiCnName(jaName) {
  if (!jaName) return null;
  const d = await fetchJSON(
    `https://api.bgm.tv/search/subject/${encodeURIComponent(jaName)}?type=2&responseGroup=small`
  );
  const hit = d && d.list && d.list[0];
  return hit ? hit.name_cn || hit.name : null;
}

// candidates in search-priority order, deduped
async function titleCandidates(type, rawId, hint) {
  const out = [];
  const push = (s) => {
    if (s && !out.includes(s)) out.push(s);
  };
  push(hint);
  if (rawId.startsWith('tt')) {
    push(await cached('tmdb:' + rawId, () => tmdbZhName(type, rawId.split(':')[0])));
    push(await cached('cm:' + rawId, () => cinemetaName(type, rawId.split(':')[0])));
  } else if (rawId.startsWith('kitsu:')) {
    const kid = rawId.split(':')[1];
    const kt = await cached('kitsu:' + kid, () => kitsuTitles(kid));
    if (kt) {
      push(await cached('bgm:' + kid, () => bangumiCnName(kt.ja)));
      push(kt.ja);
      push(kt.en);
    }
  }
  return out;
}

// ---- 苹果CMS search ----
async function searchApi(api, kw) {
  const d = await fetchJSON(`${api.base}?ac=detail&wd=${encodeURIComponent(kw)}`, 15000);
  if (!d || !Array.isArray(d.list)) return [];
  return d.list;
}

function pickVod(list, kw) {
  if (!list.length) return null;
  const exact = list.find((v) => v.vod_name === kw);
  if (exact) return exact;
  const contains = list.find((v) => v.vod_name && (v.vod_name.includes(kw) || kw.includes(v.vod_name)));
  return contains || list[0];
}

// returns [{title, url}] for one vod entry, in episode order
function vodEpisodes(vod) {
  const froms = String(vod.vod_play_from || '').split('$$$');
  const groups = String(vod.vod_play_url || '').split('$$$');
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const from = (froms[i] || '').toLowerCase();
    // prefer m3u8 groups; still accept groups whose urls are media files
    const eps = groups[i].split('#').filter(Boolean).map((seg) => {
      const idx = seg.lastIndexOf('$');
      if (idx < 0) return null;
      return { name: seg.slice(0, idx) || '正片', url: seg.slice(idx + 1).trim(), from };
    }).filter(Boolean);
    for (const e of eps) {
      if (/^https?:\/\//.test(e.url) && /(\.m3u8|\.mp4)(\?|$)/i.test(e.url)) out.push(e);
    }
    if (out.length) break; // first group that yields direct media links wins
  }
  return out;
}

async function resolveStreams(type, rawId, hint) {
  // parse episode target
  const parts = rawId.split(':');
  let wantEp = 0;
  if (parts[0] === 'tt' && parts.length >= 3) wantEp = parseInt(parts[2], 10) || 0;
  if (parts[0] === 'kitsu' && parts.length >= 4) wantEp = parseInt(parts[3], 10) || 0;

  const titles = await titleCandidates(type, rawId, hint);
  const streams = [];
  for (const title of titles) {
    if (streams.length) break;
    for (const api of APIS) {
      const list = await cached(`vod:${api.name}:${title}`, () => searchApi(api, title));
      if (!list || !list.length) continue;
      const vod = pickVod(list, title);
      if (!vod) continue;
      const eps = vodEpisodes(vod);
      if (!eps.length) continue;
      // order: requested episode first, then the rest in order
      const ordered = eps.slice();
      if (wantEp > 0 && wantEp <= ordered.length) {
        const [w] = ordered.splice(wantEp - 1, 1);
        ordered.unshift(w);
      }
      for (const e of ordered.slice(0, 80)) {
        streams.push({
          name: `${api.name} · ${e.name}`,
          title: `${vod.vod_name} ${e.name}（${api.name}）`,
          url: e.url,
        });
      }
      if (streams.length) break;
    }
  }
  return streams;
}

// ---- http server ----
const MANIFEST = {
  id: 'app.nezone.source',
  version: '1.0.0',
  name: 'nezone 官方源',
  description: 'nezone 自家源：中文资源站直链（非凡/百度/量子），服务器端搜索',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'kitsu'],
  catalogs: [],
};

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(body);
  };
  try {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    if (path === '/' ) return send(200, { ok: true, name: MANIFEST.name });
    if (path === '/manifest.json') return send(200, MANIFEST);
    const m = path.match(/^\/stream\/(movie|series)\/([^/]+)\.json$/);
    if (m) {
      const type = m[1];
      const rawId = decodeURIComponent(m[2]);
      const hint = u.searchParams.get('q') || '';
      const streams = await resolveStreams(type, rawId, hint);
      return send(200, { streams });
    }
    return send(404, { error: 'not found' });
  } catch (e) {
    return send(500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => console.log('nezone-source listening on ' + PORT));
