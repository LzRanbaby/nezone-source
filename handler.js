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

function epCount(v) {
  const groups = String(v.vod_play_url || '').split('$$$');
  return groups.reduce((m, g) => Math.max(m, g.split('#').filter(Boolean).length), 0);
}

function pickVod(list, kw) {
  if (!list.length) return null;
  // among real name matches, prefer the entry with the most episodes
  // (fullest version); with no name match at all, keep the old list[0] behavior
  const exact = list.filter((v) => v.vod_name === kw);
  if (exact.length) return exact.slice().sort((a, b) => epCount(b) - epCount(a))[0];
  const contains = list.filter((v) => v.vod_name && (v.vod_name.includes(kw) || kw.includes(v.vod_name)));
  if (contains.length) return contains.slice().sort((a, b) => epCount(b) - epCount(a))[0];
  return list[0];
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
  // parse episode target (episode number is the last segment in both
  // tt:season:ep and kitsu:id:ep id shapes)
  const parts = rawId.split(':');
  let wantEp = 0;
  if (parts.length >= 3) wantEp = parseInt(parts[parts.length - 1], 10) || 0;

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
      for (const e of ordered.slice(0, 2000)) {
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

// ---- 源内直搜 / 详情（集数跟资源站走，不经 Cinemeta） ----
function remarksEp(remarks) {
  const m = String(remarks || '').match(/(\d+)\s*集/);
  return m ? parseInt(m[1], 10) : 0;
}

async function searchCatalog(wd) {
  const byName = new Map();
  for (let i = 0; i < APIS.length; i++) {
    const api = APIS[i];
    const d = await cached(`cat:${api.name}:${wd}`, () =>
      fetchJSON(`${api.base}?ac=list&wd=${encodeURIComponent(wd)}`, 12000)
    );
    if (!d || !Array.isArray(d.list)) continue;
    for (const v of d.list) {
      if (!v.vod_name) continue;
      const prev = byName.get(v.vod_name);
      const cand = {
        id: `nz:${i}:${v.vod_id}`,
        name: v.vod_name,
        poster: v.vod_pic || '',
        remarks: v.vod_remarks || '',
        type: v.type_name || '',
        year: v.vod_year || '',
        ep: Math.max(remarksEp(v.vod_remarks), prev ? prev.ep : 0),
      };
      if (!prev || cand.ep >= prev.ep) byName.set(v.vod_name, cand);
    }
  }
  return [...byName.values()].slice(0, 30).map(({ ep, ...rest }) => rest);
}

async function vodDetail(apiIdx, vodId) {
  const api = APIS[apiIdx];
  if (!api) return null;
  const d = await cached(`vodfull:${api.name}:${vodId}`, () =>
    fetchJSON(`${api.base}?ac=detail&ids=${encodeURIComponent(vodId)}`, 15000)
  );
  if (!d || !Array.isArray(d.list) || !d.list.length) return null;
  const vod = d.list[0];
  const eps = vodEpisodes(vod).slice(0, 2000);
  const desc = String(vod.vod_content || vod.vod_blurb || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&quot;|&amp;/g, ' ')
    .trim();
  return {
    name: vod.vod_name,
    poster: vod.vod_pic || '',
    remarks: vod.vod_remarks || '',
    year: vod.vod_year || '',
    area: vod.vod_area || '',
    desc,
    episodes: eps.map((e) => ({ name: e.name, url: e.url })),
  };
}

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

async function handler(req, res) {
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
    let path = u.pathname;
    // Vercel rewrites deliver the function path (/api/index.js...) as req.url;
    // strip it so the Stremio routes below match on any host.
    if (path === '/api/index.js' || path === '/api') path = '/';
    else if (path.startsWith('/api/index.js/')) path = path.slice('/api/index.js'.length);
    else if (path.startsWith('/api/')) path = path.slice(4);
    if (path === '/' ) return send(200, { ok: true, name: MANIFEST.name });
    if (path === '/manifest.json') return send(200, MANIFEST);
    if (path === '/search.json') {
      const wd = (u.searchParams.get('wd') || '').trim();
      if (!wd) return send(200, { metas: [] });
      return send(200, { metas: await searchCatalog(wd) });
    }
    if (path === '/vod.json') {
      const a = parseInt(u.searchParams.get('a') || '0', 10) || 0;
      const id = u.searchParams.get('id') || '';
      const detail = await vodDetail(a, id);
      if (!detail) return send(404, { error: 'not found' });
      if (u.searchParams.get('lite')) {
        return send(200, { name: detail.name, count: detail.episodes.length, remarks: detail.remarks });
      }
      return send(200, detail);
    }
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
}

module.exports = handler;
