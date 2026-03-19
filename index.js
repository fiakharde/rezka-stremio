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

const manifest = {
  id: 'community.rezka.stremio',
  version: '1.2.0',
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

// ─── ID helpers (use | as separator, safe in base64 URL) ─────────────────────

function makeId(url) {
  return 'rezka:' + Buffer.from(url).toString('base64url');
}

function parseId(id) {
  try {
    const encoded = id.replace('rezka:', '').split('|')[0];
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

// ─── Rezka stream URL decoder ─────────────────────────────────────────────────

function clearTrash(str) {
  // Remove trash substrings inserted by rezka obfuscation
  const trashList = ['@#&', '!$^', '#', '@#^', '!@#'];
  let result = str;
  for (const trash of trashList) {
    result = result.split(trash).join('');
  }
  return result;
}

function decodeRezkaUrl(encoded) {
  if (!encoded) return '';
  // Step 1: replace #h back to //
  let str = encoded.replace(/#h/g, '//');
  // Step 2: split by //, decode each base64 segment, rejoin
  const parts = str.split('//');
  const decoded = parts.map(p => {
    const clean = clearTrash(p);
    try {
      const result = Buffer.from(clean, 'base64').toString('utf8');
      // Check if decoded looks like a URL path
      if (result && (result.startsWith('/') || result.startsWith('http') || result.includes('.'))) {
        return result;
      }
      return p;
    } catch {
      return p;
    }
  });
  return decoded.join('//');
}

function parseStreams(rawUrl) {
  // Format: [720p]url1 or url2,[1080p]url3 or url4
  const streams = [];
  if (!rawUrl) return streams;

  // Split by comma but be careful — commas can appear in URLs
  // Format is: QUALITY:url1 or url2,QUALITY:url1 or url2
  const qualityPattern = /\[([^\]]+)\](.*?)(?=,\[|$)/g;
  let match;

  while ((match = qualityPattern.exec(rawUrl)) !== null) {
    const quality = match[1];
    const urlsPart = match[2].trim();
    const urls = urlsPart.split(' or ').map(u => u.trim()).filter(u => u.length > 0);
    const bestUrl = urls[urls.length - 1]; // last is usually best mirror
    if (bestUrl) {
      streams.push({ quality, url: bestUrl });
    }
  }

  // Fallback: old format without brackets
  if (streams.length === 0) {
    const parts = rawUrl.split(',');
    for (const part of parts) {
      const colonIdx = part.indexOf(':http');
      if (colonIdx > 0) {
        const quality = part.substring(0, colonIdx).trim();
        const urlsPart = part.substring(colonIdx + 1).trim();
        const urls = urlsPart.split(' or ').map(u => u.trim()).filter(u => u.startsWith('http'));
        if (urls.length > 0) {
          streams.push({ quality, url: urls[urls.length - 1] });
        }
      }
    }
  }

  return streams;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return resp.data;
}

// ─── Parse catalog page ───────────────────────────────────────────────────────

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

// ─── Get page info ────────────────────────────────────────────────────────────

async function getPageInfo(url) {
  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  const title = $('h1[itemprop="name"]').text().trim() || $('h1').first().text().trim();
  const poster = $('.b-sidecover img').attr('src') || '';
  const description = $('[itemprop="description"]').text().trim();
  const year = $('[itemprop="dateCreated"]').text().trim();

  // Get translators
  const translators = [];
  $('#translators-list li').each((i, el) => {
    const $el = $(el);
    const tid = $el.attr('data-translator_id');
    const tname = $el.text().trim();
    if (tid) translators.push({ id: tid, name: tname });
  });

  // Extract movie ID
  let movieId = $('#player').attr('data-id') || '';
  if (!movieId) {
    const patterns = [
      /initCDN\w*\s*\(\s*(\d+)/,
      /"id_movie"\s*:\s*(\d+)/,
      /sof\.tv\.\w+\s*\(\s*(\d+)/,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) { movieId = m[1]; break; }
    }
  }

  // Fallback translator from script
  if (translators.length === 0) {
    const m = html.match(/translator_id["'\s:]+(\d+)/);
    if (m) translators.push({ id: m[1], name: 'Дубляж' });
  }

  console.log(`Page info: title="${title}", movieId=${movieId}, translators=${translators.length}`);

  return { title, poster, description, year, translators, movieId, html };
}

// ─── Fetch CDN streams ────────────────────────────────────────────────────────

async function fetchCDNStreams(movieId, translatorId, season, episode, isSeries) {
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

  console.log(`CDN request: movieId=${movieId}, translatorId=${translatorId}`);

  const resp = await axios.post(`${BASE_URL}/ajax/get_cdn_series/`, postData, {
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeout: 15000,
  });

  const data = resp.data;
  console.log(`CDN response success=${data.success}, has url=${!!data.url}`);

  if (!data.success) return [];

  const rawUrl = data.url || '';
  console.log(`Raw URL (first 200): ${rawUrl.substring(0, 200)}`);

  // Decode the obfuscated URL
  const decodedUrl = decodeRezkaUrl(rawUrl);
  console.log(`Decoded URL (first 200): ${decodedUrl.substring(0, 200)}`);

  return parseStreams(decodedUrl);
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    let html;
    if (extra.search) {
      html = await fetchPage(`${BASE_URL}/search/?do=search&subaction=search&q=${encodeURIComponent(extra.search)}`);
    } else {
      const page = Math.floor((extra.skip || 0) / 36) + 1;
      const section = type === 'movie' ? 'films' : 'series';
      html = await fetchPage(`${BASE_URL}/${section}/page/${page}/`);
    }
    return { metas: parseResults(html, type) };
  } catch (err) {
    console.error('Catalog error:', err.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
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

builder.defineStreamHandler(async ({ type, id }) => {
  if (!id.startsWith('rezka:')) return { streams: [] };
  const url = parseId(id);
  if (!url) return { streams: [] };

  const isSeries = type === 'series';

  try {
    const info = await getPageInfo(url);
    if (!info.movieId) {
      console.log('No movieId found on page:', url);
      return { streams: [] };
    }

    const streams = [];

    for (const translator of info.translators.slice(0, 5)) {
      try {
        const qualities = await fetchCDNStreams(info.movieId, translator.id, null, null, false);
        for (const q of qualities) {
          streams.push({
            url: q.url,
            name: `${q.quality}`,
            title: translator.name,
          });
        }
        if (streams.length > 0) break; // got streams, stop trying
      } catch (e) {
        console.error(`Translator ${translator.id} error:`, e.message);
      }
    }

    // If no translators found, try default translator id=1
    if (streams.length === 0) {
      try {
        const qualities = await fetchCDNStreams(info.movieId, '1', null, null, false);
        for (const q of qualities) {
          streams.push({ url: q.url, name: q.quality, title: 'Дубляж' });
        }
      } catch (e) {
        console.error('Default translator error:', e.message);
      }
    }

    console.log(`Total streams: ${streams.length}`);
    return { streams };
  } catch (err) {
    console.error('Stream error:', err.message);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Rezka addon v1.2 running on port ${PORT}`);
