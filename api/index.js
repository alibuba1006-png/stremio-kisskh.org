const express = require("express");
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
  "Origin": "https://kisskh.co"
};

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

async function searchKisskh(query, kissType) {
  try {
    const url = `${KISSKH_BASE}/api/DramaList/Search?q=${encodeURIComponent(query)}&type=${kissType}`;
    const response = await axios.get(url, { headers: HEADERS, timeout: 8000 });
    return response.data || [];
  } catch (e) {
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

        return type === "movie" ? (item.type === 2 || epCount === 1) : (item.type === 1 || epCount > 1);
      });
    } else {
      const pageSkip = isNaN(skip) ? 0 : skip;
      const currentPage = Math.floor(pageSkip / 10) + 1;
      dramas = await fetchPageFromKisskh(kissType, currentPage);
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

    if (imdbId) metaObj.imdb_id = imdbId;
    return metaObj;
  } catch (error) {
    return null;
  }
}

async function getKisskhStream(episodeId) {
  try {
    const url = `${KISSKH_BASE}/api/DramaList/Episode/${episodeId}.json?sub=true`;
    const response = await axios.get(url, { headers: HEADERS, timeout: 8000 });

    if (response.data && response.data.Video) {
      return [{
        title: "KissKH HD Stream",
        url: response.data.Video
      }];
    }
  } catch (e) {}
  return [];
}

// --- EXPRESS SERVER ---
const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

app.get("/manifest.json", (req, res) => res.json(manifest));
app.get("/", (req, res) => res.json(manifest));

app.get("/catalog/:type/:id/:extra?.json", async (req, res) => {
  const { type, extra } = req.params;
  let search = null, skip = 0;
  if (extra) {
    const params = new URLSearchParams(extra);
    search = params.get("search");
    skip = parseInt(params.get("skip")) || 0;
  }
  const metas = await getKisskhCatalog(type, skip, search);
  res.json({ metas });
});

app.get("/meta/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  if (!id.startsWith("kisskh:")) return res.json({ meta: null });
  const dramaId = id.replace("kisskh:", "");
  const meta = await getKisskhMeta(dramaId, type);
  res.json({ meta });
});

app.get("/stream/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  let episodeId = null;

  if (id.startsWith("tt")) {
    const parts = id.split(":");
    const imdbId = parts[0];
    const requestedEp = parts[2] || "1";
    const cinemeta = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`).catch(() => null);
    const title = cinemeta?.data?.meta?.name;

    if (title) {
      const results = await searchKisskh(title, type === "movie" ? 2 : 1);
      if (results.length > 0) {
        const meta = await getKisskhMeta(results[0].id, type);
        const targetEp = meta?.videos?.find(v => v.number === parseInt(requestedEp)) || meta?.videos?.[0];
        if (targetEp) episodeId = targetEp.id.split(":")[2];
      }
    }
  } else if (id.startsWith("kisskh:")) {
    episodeId = id.split(":")[2];
  }

  if (!episodeId) return res.json({ streams: [] });
  const streams = await getKisskhStream(episodeId);
  res.json({ streams });
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon running on port ${PORT}`));
