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

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Referer": "https://kisskh.co/",
  "Origin": "https://kisskh.co",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9"
};

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
    const response = await axios.get(url, { headers: HEADERS, timeout: 8000 });
    return response.data || [];
  } catch (e) {
    console.error("Search Error:", e.message);
    return [];
  }
}

async function fetchPageFromKisskh(kissType, page) {
  try {
    const url = `${KISSKH_BASE}/api/DramaList/List?page=${page}&type=${kissType}&sub=0&country=0&status=0&order=2`;
    const response = await axios.get(url, { headers: HEADERS, timeout: 10000 });
    
    if (Array.isArray(response.data)) return response.data;
    if (response.data && Array.isArray(response.data.data)) return response.data.data;
    
    return [];
  } catch (e) {
    console.error(`Fetch Page ${page} Error:`, e.message);
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
      const pageSkip = isNaN(skip) ? 0 : skip;
      const startPage = Math.floor(pageSkip / 10) + 1;
      
      const [data1, data2] = await Promise.all([
        fetchPageFromKisskh(kissType, startPage),
        fetchPageFromKisskh(kissType, startPage + 1)
      ]);
      dramas = [...data1, ...data2];
    }

    console.log(`Fetched ${dramas.length} items for catalog: ${type}`);

    return dramas.map(item => ({
      id: `kisskh:${item.id}`,
      type: type,
      name: item.title,
      poster: item.thumbnail,
      description: `Епизоди: ${item.episodesCount || (type === "movie" ? "1" : "N/A")}`
    }));
  } catch (error) {
    console.error("Catalog Processing Error:", error.message);
    return [];
  }
}

async function getKisskhMeta(dramaId, type) {
  try {
    const url = `${KISSKH_BASE}/api/DramaList/Drama/${dramaId}?sub=true`;
    const response = await axios.get(url, { headers: HEADERS, timeout: 10000 });
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
    console.error("Meta Error:", error.message);
    return null;
  }
}

async function getKisskhStream(episodeId) {
  try {
    const response = await axios.get(`${KISSKH_BASE}/api/DramaList/Episode/${episodeId}.json?sub=true`, {
      headers: HEADERS,
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

// --- VERCEL SERVERLESS HANDLER ---
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json");

  const url = req.url.split("?")[0];

  // 1. Manifest
  if (url === "/manifest.json" || url === "/") {
    return res.status(200).json(manifest);
  }

  // 2. Catalog
  if (url.startsWith("/catalog/")) {
    const cleanPath = url.replace(".json", "");
    const parts = cleanPath.split("/").filter(Boolean);
    
    const type = parts[1];
    let search = null;
    let skip = 0;

    if (parts[3]) {
      const extraParams = new URLSearchParams(parts[3]);
      search = extraParams.get("search");
      skip = parseInt(extraParams.get("skip")) || 0;
    }

    const metas = await getKisskhCatalog(type, skip, search);
    return res.status(200).json({ metas });
  }

  // 3. Meta
  if (url.startsWith("/meta/")) {
    const cleanPath = url.replace(".json", "");
    const parts = cleanPath.split("/").filter(Boolean);
    const type = parts[1];
    const id = parts[2];

    if (!id || !id.startsWith("kisskh:")) return res.status(200).json({ meta: null });
    const dramaId = id.replace("kisskh:", "");
    const meta = await getKisskhMeta(dramaId, type);
    return res.status(200).json({ meta });
  }

  // 4. Stream
  if (url.startsWith("/stream/")) {
    const cleanPath = url.replace(".json", "");
    const parts = cleanPath.split("/").filter(Boolean);
    const type = parts[1];
    const id = parts[2];

    let episodeId = null;

    if (id && id.startsWith("tt")) {
      const idParts = id.split(":");
      const imdbId = idParts[0];
      const requestedEpisode = idParts[2] || "1";

      const cinemetaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`).catch(() => null);
      const title = cinemetaRes && cinemetaRes.data && cinemetaRes.data.meta ? cinemetaRes.data.meta.name : null;

      if (title) {
        const kissType = type === "movie" ? 2 : 1;
        const searchResults = await searchKisskh(title, kissType);

        if (searchResults.length > 0) {
          const dramaId = searchResults[0].id;
          const meta = await getKisskhMeta(dramaId, type);
          if (meta && meta.videos && meta.videos.length > 0) {
            const targetEp = meta.videos.find(v => v.number === parseInt(requestedEpisode)) || meta.videos[0];
            const epParts = targetEp.id.split(":");
            episodeId = epParts[2];
          }
        }
      }
    } else if (id && id.startsWith("kisskh:")) {
      const epParts = id.split(":");
      episodeId = epParts[2];
    }

    if (!episodeId) return res.status(200).json({ streams: [] });

    const streams = await getKisskhStream(episodeId);
    return res.status(200).json({ streams });
  }

  return res.status(404).json({ error: "Not Found" });
};
