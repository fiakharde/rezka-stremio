const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://rezka.ag';
const PORT = process.env.PORT || 7000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
  'Referer': BASE_URL,
};

// ─── Manifest ────────────────────────────────────────────────────────────────

const manifest = {
  id: 'community.rezka.stremio',
  version: '1.1.0',
  name: 'Rezka',
  description: 'Фильмы и сериалы с rezka.ag — русская озвучка',
  logo: 'https://rezka.ag/templates/hdrezka/images/hdrezka-logo.png',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['rezka:'],
  catalogs: [
    {
      type: 'movie',
      id: 'rezka-movies',
      name: 'Rezka Фильмы',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip' }],
    },
    {
      type: 'series',
      id: 'rezka-series',
      name: 'Rezka Сериалы',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip' }],
    },
  ],
};

const builder = new addonBuilder(manifest);

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ID format: rezka:BASE64_ENCODED_URL
// This way we always know the exact URL to fetch

function makeId(url) {
  return 'rezka:' + Buffer.from(url).toString('base64').replace(/=/g, '');
}

function parseId(id) {
  const encoded = id.replace('rezka:', '');
  // Add padding back
  const padded = encoded + '=='.slice(0, (4 - encoded.length % 4) % 4);
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function decodeStreamUrls(encoded) {
  if (!encoded) return '';
  let decoded = encoded.replace(/\/\//g, '').replace(/#h/g, '//').replace(/\^/g, '0');
  try {
    const parts = decoded.split('/');
    const result = parts.map(part => {
      try { return Buffer.from(part, 'base64').toString('utf8'); } catch { return part; }
    });
    const joined = result.join('/');
    if (joined.includes('http')) return joined;
  } catch {}
  return decoded;
}

function parseQualities(streamsStr) {
  const results = [];
  if (!streamsStr) return results;
  const pairs = streamsStr.split(',');
  for (const pair of pairs) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) continue;
    const quality = pair.substring(0, colonIdx).trim();
    const urlsPart = pair.substring(colonIdx + 1).trim();
    const urls = urlsPart.split(' or ').map(u => u.trim()).filter(u => u.startsWith('http'));
    if (urls.length > 0) {
      results.push({ quality, url: urls[urls.length - 1] });
    }
  }
  return results;
}

async function fetchPage(url) {
  const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return resp.data;
}

// ─── Parse catalog results ───────────────────────────────────────────────────

function parseResults(html, type) {
  const $ = cheerio.load(html);
  const items = [];

  $('.b-content__inline_item').each((i, el) => {
    const $el = $(el);
    const link = $el.find('.b-content__inline_item-link a').first();
    const href = link.attr('href') || '';
    const title = link.text().trim();
    const img = $el.find('img').attr('src') || '';
    const year = $el.find('.b-content__inline_item-link div').text().trim().match(/\d{4}/)?.[0] || '';

    if (!href || !title) return;

    const isMovie = href.includes('/films/') || href.includes('/cartoons/') || href.includes('/animation/');
    const isSeries = href.includes('/series/') || href.includes('/cartoons-series/');

    if (type === 'movie' && !isMovie) return;
    if (type === 'series' && !isSeries) return;

    const fullUrl = href.startsWith('http') ? href : BASE_URL + href;

    items.push({
      id: makeId(fullUrl),
      type,
      name: title,
      poster: img,
      year: year ? parseInt(year) : undefined,
    });
  });

  return items;
}

// ─── Get page details ────────────────────────────────────────────────────────

async function getPageInfo(url) {
  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  const title = $('h1[itemprop="name"]').text().trim() || $('h1').first().text().trim();
  const poster = $('.b-sidecover img').attr('src') || '';
  const description = $('[itemprop="description"]').text().trim();
  const year = $('[itemprop="dateCreated"]').text().trim() || '';

  const translators = [];
  $('#translators-list li').each((i, el) => {
    const $el = $(el);
    const tid = $el.attr('data-translator_id');
    const tname = $el.text().trim();
    if (tid) translators.push({ id: tid, name: tname });
  });

  // Get movie ID from page scripts
  let movieId = $('#player').attr('data-id') || '';
  if (!movieId) {
    const match = html.match(/initCDN\w*\s*\(\s*(\d+)/);
    if (match) movieId = match[1];
  }
  if (!movieId) {
    const match = html.match(/"id_movie"\s*:\s*(\d+)/);
    if (match) movieId = match[1];
  }

  // Also try to get translator from inline script
  if (translators.length === 0) {
    const match = html.match(/translator_id\s*[:=]\s*(\d+)/);
    if (match) translators.push({ id: match[1], name: 'Перевод' });
  }

  return { title, poster, description, year, translators, movieId };
}

// ─── Fetch streams ───────────────────────────────────────────────────────────

async function fetchStreams(movieId, translatorId, season, episode, isSeries) {
  const postData = new URLSearchParams();
  postData.append('id', movieId);
  postData.append('translator_id', translatorId);

  if (isSeries && season && episode) {
    postData.append('season', season);
    postData.append('episode', episode);
    postData.append('action', 'get_stream');
  } else {
    postData.append('action', 'get_movie');
  }

  try {
    const resp = await axios.post(`${BASE_URL}/ajax/get_cdn_series/`, postData, {
      headers: {
        ...HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 15000,
    });

    const data = resp.data;
    if (!data.success) return [];

    const rawUrls = data.url || data.streams || '';
    const decoded = decodeStreamUrls(rawUrls);
    return parseQualities(decoded);
  } catch (err) {
    console.error('fetchStreams error:', err.message);
    return [];
  }
}

// ─── Catalog Handler ──────────────────────────────────────────────────────────

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`Catalog: type=${type}, search=${extra.search || ''}, skip=${extra.skip || 0}`);
  try {
    let html;
    if (extra.search) {
      const url = `${BASE_URL}/search/?do=search&subaction=search&q=${encodeURIComponent(extra.search)}`;
      html = await fetchPage(url);
    } else {
      const page = Math.floor((extra.skip || 0) / 36) + 1;
      const section = type === 'movie' ? 'films' : 'series';
      html = await fetchPage(`${BASE_URL}/${section}/page/${page}/`);
    }
    const metas = parseResults(html, type);
    return { metas };
  } catch (err) {
    console.error('Catalog error:', err.message);
    return { metas: [] };
  }
});

// ─── Meta Handler ─────────────────────────────────────────────────────────────

builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`Meta: type=${type}, id=${id}`);
  if (!id.startsWith('rezka:')) return { meta: null };

  const url = parseId(id);
  if (!url) return { meta: null };

  try {
    const info = await getPageInfo(url);
    return {
      meta: {
        id,
        type,
        name: info.title || 'Без названия',
        poster: info.poster,
        description: info.description,
        year: info.year ? parseInt(info.year) : undefined,
        background: info.poster,
      }
    };
  } catch (err) {
    console.error('Meta error:', err.message);
    return { meta: null };
  }
});

// ─── Stream Handler ───────────────────────────────────────────────────────────

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`Stream: type=${type}, id=${id}`);
  if (!id.startsWith('rezka:')) return { streams: [] };

  // ID might contain season/episode: rezka:BASE64:season:episode
  const parts = id.split(':');
  const encodedUrl = parts[1];
  const season = parts[2] || null;
  const episode = parts[3] || null;

  const padded = encodedUrl + '=='.slice(0, (4 - encodedUrl.length % 4) % 4);
  let url;
  try {
    url = Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return { streams: [] };
  }

  const isSeries = type === 'series' && season && episode;

  try {
    const info = await getPageInfo(url);
    if (!info.movieId) {
      console.log('No movie ID found for:', url);
      return { streams: [] };
    }

    const streams = [];

    // Try first translator
    const translatorId = info.translators[0]?.id || '1';
    const qualities = await fetchStreams(info.movieId, translatorId, season, episode, isSeries);

    for (const q of qualities) {
      streams.push({
        url: q.url,
        name: `Rezka ${q.quality}`,
        title: info.translators[0]?.name || 'Дубляж',
      });
    }

    // If no streams from first, try other translators
    if (streams.length === 0 && info.translators.length > 1) {
      for (const translator of info.translators.slice(1, 4)) {
        const qs = await fetchStreams(info.movieId, translator.id, season, episode, isSeries);
        for (const q of qs) {
          streams.push({
            url: q.url,
            name: `${q.quality}`,
            title: translator.name,
          });
        }
        if (streams.length > 0) break;
      }
    }

    console.log(`Found ${streams.length} streams`);
    return { streams };
  } catch (err) {
    console.error('Stream error:', err.message);
    return { streams: [] };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Rezka addon running on port ${PORT}`);
