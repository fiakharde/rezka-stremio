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
  version: '1.0.0',
  name: 'Rezka',
  description: 'Фильмы и сериалы с rezka.ag — русская озвучка, субтитры',
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

// Decode rezka stream URLs (they use a simple obfuscation)
function decodeStreamUrls(encoded) {
  if (!encoded) return '';
  // Step 1: replace trash characters
  let decoded = encoded
    .replace(/\/\//g, '')
    .replace(/#h/g, '//')
    .replace(/\^/g, '0');

  // Step 2: decode base64 chunks separated by /
  try {
    const parts = decoded.split('/');
    const result = parts.map(part => {
      try {
        return Buffer.from(part, 'base64').toString('utf8');
      } catch {
        return part;
      }
    });
    const joined = result.join('/');
    if (joined.includes('http')) return joined;
  } catch {}

  return decoded;
}

// Parse quality + URL pairs from decoded stream string
// Format: "1080p:url1 or url2,720p:url3 or url4,..."
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
      results.push({ quality, url: urls[urls.length - 1] }); // prefer last (usually best mirror)
    }
  }
  return results;
}

// Fetch HTML from rezka
async function fetchPage(url) {
  const resp = await axios.get(url, { headers: HEADERS, timeout: 10000 });
  return resp.data;
}

// Search rezka.ag
async function searchRezka(query, type) {
  const typeParam = type === 'movie' ? 'films' : 'series';
  const url = `${BASE_URL}/search/?do=search&subaction=search&q=${encodeURIComponent(query)}`;
  const html = await fetchPage(url);
  return parseSearchResults(html, type);
}

// Get main page items (catalog without search)
async function getCatalog(type, skip = 0) {
  const page = Math.floor(skip / 36) + 1;
  const section = type === 'movie' ? 'films' : 'series';
  const url = `${BASE_URL}/${section}/page/${page}/`;
  const html = await fetchPage(url);
  return parseSearchResults(html, type);
}

// Parse search/catalog results HTML
function parseSearchResults(html, type) {
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

    // Extract ID from URL
    const idMatch = href.match(/\/(\d+)-/);
    if (!idMatch) return;
    const rezkaId = idMatch[1];

    // Detect type from URL
    const isMovie = href.includes('/films/') || href.includes('/cartoons/') || href.includes('/animation/');
    const isSeries = href.includes('/series/') || href.includes('/cartoons-series/');

    if (type === 'movie' && !isMovie) return;
    if (type === 'series' && !isSeries) return;

    items.push({
      id: `rezka:${rezkaId}`,
      type,
      name: title,
      poster: img,
      year: year ? parseInt(year) : undefined,
      rezkaUrl: href,
    });
  });

  return items;
}

// Get page info for meta
async function getPageInfo(rezkaUrl) {
  const html = await fetchPage(rezkaUrl);
  const $ = cheerio.load(html);

  const title = $('h1[itemprop="name"]').text().trim() || $('h1').first().text().trim();
  const poster = $('.b-sidecover img').attr('src') || '';
  const description = $('[itemprop="description"]').text().trim();
  const year = $('[itemprop="dateCreated"]').text().trim() || '';
  const rating = $('[itemprop="ratingValue"]').text().trim() || '';

  // Get translators
  const translators = [];
  $('#translators-list li').each((i, el) => {
    const $el = $(el);
    translators.push({
      id: $el.attr('data-translator_id'),
      name: $el.text().trim(),
    });
  });

  // Get movie/series ID from page
  const movieId = $('#player').attr('data-id') ||
    html.match(/sof\.tv\.initCDN[A-Za-z]*\s*\(\s*(\d+)/)?.[1] || '';

  // Get seasons/episodes for series
  const seasons = [];
  $('.b-simple_seasons__item').each((i, el) => {
    const $el = $(el);
    seasons.push({
      id: $el.attr('data-tab_id'),
      name: $el.text().trim(),
    });
  });

  return { title, poster, description, year, rating, translators, movieId, seasons };
}

// Fetch stream URLs from rezka AJAX endpoint
async function fetchStreams(movieId, translatorId, season = null, episode = null, isSeries = false) {
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

  const resp = await axios.post(`${BASE_URL}/ajax/get_cdn_series/`, postData, {
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeout: 10000,
  });

  const data = resp.data;
  if (!data.success) return [];

  const rawUrls = data.url || data.streams || '';
  const decoded = decodeStreamUrls(rawUrls);
  return parseQualities(decoded);
}

// ─── Catalog Handler ──────────────────────────────────────────────────────────

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`Catalog request: type=${type}, id=${id}, extra=`, extra);
  try {
    let metas;
    if (extra.search) {
      metas = await searchRezka(extra.search, type);
    } else {
      metas = await getCatalog(type, extra.skip || 0);
    }
    return { metas };
  } catch (err) {
    console.error('Catalog error:', err.message);
    return { metas: [] };
  }
});

// ─── Meta Handler ─────────────────────────────────────────────────────────────

builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`Meta request: type=${type}, id=${id}`);
  if (!id.startsWith('rezka:')) return { meta: null };

  try {
    // We need the URL — search for it
    const rezkaId = id.replace('rezka:', '');
    // Try to construct URL (works for most cases)
    const searchUrl = `${BASE_URL}/search/?do=search&subaction=search&q=${rezkaId}`;
    const html = await fetchPage(searchUrl);
    const $ = cheerio.load(html);

    let rezkaUrl = '';
    $('.b-content__inline_item').each((i, el) => {
      const href = $(el).find('.b-content__inline_item-link a').attr('href') || '';
      if (href.includes(`/${rezkaId}-`)) {
        rezkaUrl = href;
        return false;
      }
    });

    if (!rezkaUrl) return { meta: null };

    const info = await getPageInfo(rezkaUrl);

    const meta = {
      id,
      type,
      name: info.title,
      poster: info.poster,
      description: info.description,
      year: info.year ? parseInt(info.year) : undefined,
      imdbRating: info.rating || undefined,
      background: info.poster,
    };

    // Add videos for series
    if (type === 'series' && info.seasons.length > 0 && info.translators.length > 0) {
      // We'll add basic season/episode structure
      meta.videos = [];
      // Note: Full episode list requires additional AJAX calls per season
      // This is a simplified version
    }

    return { meta };
  } catch (err) {
    console.error('Meta error:', err.message);
    return { meta: null };
  }
});

// ─── Stream Handler ───────────────────────────────────────────────────────────

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`Stream request: type=${type}, id=${id}`);
  if (!id.startsWith('rezka:')) return { streams: [] };

  try {
    const parts = id.replace('rezka:', '').split(':');
    const rezkaId = parts[0];
    const season = parts[1] || null;
    const episode = parts[2] || null;
    const isSeries = type === 'series' && season && episode;

    // Find the page URL
    const searchUrl = `${BASE_URL}/search/?do=search&subaction=search&q=${rezkaId}`;
    const html = await fetchPage(searchUrl);
    const $ = cheerio.load(html);

    let rezkaUrl = '';
    $('.b-content__inline_item').each((i, el) => {
      const href = $(el).find('.b-content__inline_item-link a').attr('href') || '';
      if (href.includes(`/${rezkaId}-`)) {
        rezkaUrl = href;
        return false;
      }
    });

    if (!rezkaUrl) return { streams: [] };

    const info = await getPageInfo(rezkaUrl);
    if (!info.movieId) return { streams: [] };

    const streams = [];
    const translatorId = info.translators[0]?.id || '1';

    const qualities = await fetchStreams(
      info.movieId,
      translatorId,
      season,
      episode,
      isSeries
    );

    for (const q of qualities) {
      streams.push({
        url: q.url,
        name: `Rezka ${q.quality}`,
        title: info.translators[0]?.name || 'Дубляж',
        behaviorHints: { notWebReady: false },
      });
    }

    // If multiple translators available, fetch for each (optional, first one is usually best)
    if (info.translators.length > 1 && streams.length === 0) {
      for (const translator of info.translators.slice(0, 3)) {
        if (!translator.id) continue;
        const qs = await fetchStreams(info.movieId, translator.id, season, episode, isSeries);
        for (const q of qs) {
          streams.push({
            url: q.url,
            name: `${q.quality}`,
            title: translator.name,
            behaviorHints: { notWebReady: false },
          });
        }
      }
    }

    console.log(`Found ${streams.length} streams`);
    return { streams };

  } catch (err) {
    console.error('Stream error:', err.message);
    return { streams: [] };
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Rezka Stremio Addon running on port ${PORT}`);
console.log(`Add to Stremio: http://YOUR_SERVER_IP:${PORT}/manifest.json`);
