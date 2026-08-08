const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");

const KISSKH_BASE = "https://kisskh.co";

const manifest = {
  id: "org.kisskh.stremio",
  version: "5.0.0",
  name: "KissKH Addon",
  description: "Гледай Азиатски сериали и филми от KissKH в Stremio",
  resources: ["catalog", "meta", "stream"],
  types: ["series", "movie"],
  idPrefixes: ["kisskh:", "tt"],
  catalogs: [
    {
      type: "series",
      id: "kisskh_series_catalog",
      name: "Kisskh.co Series",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    },
    {
      type: "movie",
      id: "kisskh_movies_catalog",
      name: "Kisskh.co Movie",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    }
  ]
};

const builder = new addonBuilder(manifest);

// --- ХЕЛПЪР ЗА НАМИРАНЕ НА IMDb ID ---
async function findIMDbId(title, type) {
  try {
    const endpoint = type === "movie" ? "movie" : "series";
    const cleanTitle = title.replace(/\(\d{4}\)/g, "").trim();
    const res = await axios.get(`https://v3-cinemeta.strem.io/catalog/${endpoint}/top/search=${encodeURIComponent(cleanTitle)}.json`);
    
    if (res && res.data && res.data.metas && res.data.metas.length > 0) {
      return res.data.metas[0].id;
    }
  } catch (e) {}
  return null;
}

// --- ХЕЛПЪРИ ТЪРСЕНЕ И КАТАЛОГ ---
async function searchKisskh(query, kissType) {
  try {
    const url = `${KISSKH_BASE}/api/DramaList/Search?q=${encodeURIComponent(query)}&type=${kissType}`;
    const response = await axios.get(url, {
      headers: { "Referer": "https://kisskh.co/" },
      timeout: 8000
    });
    return response.data || [];
  } catch (e) {
    return [];
  }
}

async function fetchPageFromKisskh(kissType, page) {
  try {
    const url = `${KISSKH_BASE}/api/DramaList/List?page=${page}&type=${kissType}&sub=0&country=0&status=0&order=2`;
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://kisskh.co/"
      },
      timeout: 10000
    });
    return response.data.data || [];
  } catch (e) {
    return [];
  }
}

async function getKisskhCatalog(type, skip = 0, searchQuery = null) {
  try {
    const kissType = type === "movie" ? 2 : 1; 
    let dramas = [];

    if (searchQuery) {
      const rawResults = await searchKisskh(searchQuery, kissType);
      const cleanQuery = searchQuery.toLowerCase().trim();

      dramas = rawResults.filter(item => {
        const itemTitle = (item.title || "").toLowerCase();
        const epCount = parseInt(item.episodesCount) || 0;

        const isTitleMatch = itemTitle.includes(cleanQuery);
        if (!isTitleMatch) return false;

        if (type === "movie") {
          return item.type === 2 || epCount === 1;
        } else {
          return item.type === 1 || epCount > 1;
        }
      });
    } else {
      const startPage = Math.floor(skip / 10) + 1;
      const [data1, data2] = await Promise.all([
        fetchPageFromKisskh(kissType, startPage),
        fetchPageFromKisskh(kissType, startPage + 1)
      ]);
      dramas = [...data1, ...data2];
    }

    return dramas.map(item => ({
      id: `kisskh:${item.id}`,
      type: type,
      name: item.title,
      poster: item.thumbnail,
      description: `Епизоди: ${item.episodesCount || (type === "movie" ? "1" : "N/A")}`
    }));
  } catch (error) {
    return [];
  }
}

async function getKisskhMeta(dramaId, type) {
  try {
    const url = `${KISSKH_BASE}/api/DramaList/Drama/${dramaId}?sub=true`;
    const response = await axios.get(url, {
      headers: { "Referer": "https://kisskh.co/" },
      timeout: 10000
    });
    const drama = response.data;

    let rawEpisodes = drama.episodes || [];
    rawEpisodes.sort((a, b) => (parseInt(a.number) || 0) - (parseInt(b.number) || 0));

    const imdbId = await findIMDbId(drama.title, type);

    const episodes = rawEpisodes.map(ep => ({
      id: `kisskh:${dramaId}:${ep.id}:${ep.number || 1}`,
      title: ep.number ? `Епизод ${ep.number}` : "Гледай Филма",
      season: 1,
      number: parseInt(ep.number) || 1
    }));

    const metaObj = {
      id: `kisskh:${dramaId}`,
      type: type,
      name: drama.title,
      poster: drama.thumbnail,
      description: drama.description || "Няма описание.",
      videos: episodes
    };

    if (imdbId) {
      metaObj.imdb_id = imdbId;
    }

    return metaObj;
  } catch (error) {
    return null;
  }
}

// --- ИЗВЛИЧАНЕ НА СТРИЙМ ---
async function getKisskhStream(episodeId) {
  try {
    const response = await axios.get(`${KISSKH_BASE}/api/DramaList/Episode/${episodeId}.json?sub=true`, {
      headers: { "Referer": "https://kisskh.co/" },
      timeout: 8000
    });

    if (response.data && response.data.Video) {
      return [{
        title: "KissKH HD Stream",
        url: response.data.Video
      }];
    }
  } catch (e) {
    console.error("Stream Fetch Error:", e.message);
  }
  return [];
}

// --- HANDLERS ---
builder.defineCatalogHandler(async (args) => {
  const skip = (args.extra && args.extra.skip) ? parseInt(args.extra.skip) : 0;
  const search = (args.extra && args.extra.search) ? args.extra.search : null;
  const metas = await getKisskhCatalog(args.type, skip, search);
  return { metas };
});

builder.defineMetaHandler(async (args) => {
  if (!args.id.startsWith("kisskh:")) return { meta: null };
  const dramaId = args.id.replace("kisskh:", "");
  const meta = await getKisskhMeta(dramaId, args.type);
  return { meta };
});

builder.defineStreamHandler(async (args) => {
  let dramaId, episodeId;

  if (args.id.startsWith("tt")) {
    const idParts = args.id.split(":");
    const imdbId = idParts[0];
    const requestedEpisode = idParts[2] || "1";

    const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${args.type}/${imdbId}.json`).catch(() => null);
    const title = res && res.data && res.data.meta ? res.data.meta.name : null;

    if (title) {
      const kissType = args.type === "movie" ? 2 : 1;
      const searchResults = await searchKisskh(title, kissType);

      if (searchResults.length > 0) {
        dramaId = searchResults[0].id;
        const meta = await getKisskhMeta(dramaId, args.type);
        if (meta && meta.videos && meta.videos.length > 0) {
          const targetEp = meta.videos.find(v => v.number === parseInt(requestedEpisode)) || meta.videos[0];
          const epParts = targetEp.id.split(":");
          episodeId = epParts[2];
        }
      }
    }
  } else if (args.id.startsWith("kisskh:")) {
    const parts = args.id.split(":");
    episodeId = parts[2];
  }

  if (!episodeId) return { streams: [] };

  const streams = await getKisskhStream(episodeId);
  return { streams };
});

// --- ЕКСПОРТ ЗА VERCEL SERVERLESS ---
const addonInterface = builder.getInterface();

module.exports = (req, res) => {
  // Напасваме заявката специално за Vercel /api/ структурата:
  let url = req.url.replace(/^\/api/, "");
  if (!url || url === "/") {
    url = "/manifest.json";
  }
  req.url = url;

  return addonInterface.get(req, res);
};
