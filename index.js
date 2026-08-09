import pkg from "stremio-addon-sdk";
const { addonBuilder, serveHTTP, getInterface } = pkg;
import axios from "axios";

const KISSKH_BASE = "https://kisskh.co";

const manifest = {
    id: "org.kisskh.stremio",
    version: "6.6.0",
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

async function findIMDbId(title, type) {
    try {
        const endpoint = type === "movie" ? "movie" : "series";
        const cleanTitle = title.replace(/\(\d{4}\)/g, "").trim(); 
        const res = await axios.get(`https://v3-cinemeta.strem.io/catalog/${endpoint}/top/search=${encodeURIComponent(cleanTitle)}.json`, { timeout: 5000 });
        if (res && res.data && res.data.metas && res.data.metas.length > 0) {
            return res.data.metas[0].id; 
        }
    } catch (e) {}
    return null;
}

async function searchKisskh(query, kissType) {
    try {
        const url = `${KISSKH_BASE}/api/DramaList/Search?q=${encodeURIComponent(query)}&type=${kissType}`;
        const response = await axios.get(url, {
            headers: { "Referer": "https://kisskh.co/" },
            timeout: 5000
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
            timeout: 5000
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
                fetchPageFromKisskh(kissType, startPage).catch(() => []),
                fetchPageFromKisskh(kissType, startPage + 1).catch(() => [])
            ]);
            dramas = [...data1, ...data2];
        }

        return dramas.map(item => ({
            id: `kisskh:${item.id}`,
            type: type,
            name: item.title || "Unknown",
            poster: item.thumbnail || "",
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
            timeout: 5000
        });
        const drama = response.data;
        if (!drama) return null;

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
            name: drama.title || "Unknown",
            poster: drama.thumbnail || "",
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

async function getKisskhStream(episodeId) {
    try {
        const url = `${KISSKH_BASE}/api/DramaList/Episode/${episodeId}`;
        const response = await axios.get(url, {
            headers: { "Referer": "https://kisskh.co/" },
            timeout: 5000
        });
        
        const videoUrl = response.data?.video || response.data?.link || response.data?.source;
        if (videoUrl) {
            return [{
                title: "KissKH HD Stream",
                url: videoUrl
            }];
        }
    } catch (err) {}
    return [];
}

builder.defineCatalogHandler(async (args) => {
    try {
        const skip = (args.extra && args.extra.skip) ? parseInt(args.extra.skip) : 0;
        const search = (args.extra && args.extra.search) ? args.extra.search : null;
        const metas = await getKisskhCatalog(args.type, skip, search);
        return { metas };
    } catch (e) {
        return { metas: [] };
    }
});

builder.defineMetaHandler(async (args) => {
    try {
        if (!args.id || !args.id.startsWith("kisskh:")) return { meta: null };
        const dramaId = args.id.replace("kisskh:", "");
        const meta = await getKisskhMeta(dramaId, args.type);
        return { meta };
    } catch (e) {
        return { meta: null };
    }
});

builder.defineStreamHandler(async (args) => {
    try {
        let episodeId = null;

        if (args.id && args.id.startsWith("tt")) {
            const idParts = args.id.split(":");
            const imdbId = idParts[0];
            const requestedEpisode = idParts[2] || "1";

            const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${args.type}/${imdbId}.json`).catch(() => null);
            const title = res && res.data && res.data.meta ? res.data.meta.name : null;

            if (title) {
                const kissType = args.type === "movie" ? 2 : 1;
                const searchResults = await searchKisskh(title, kissType);

                if (searchResults.length > 0) {
                    const dramaId = searchResults[0].id;
                    const meta = await getKisskhMeta(dramaId, args.type);
                    if (meta && meta.videos && meta.videos.length > 0) {
                        const targetEp = meta.videos.find(v => v.number === parseInt(requestedEpisode)) || meta.videos[0];
                        const epParts = targetEp.id.split(":");
                        episodeId = epParts[2];
                    }
                }
            }
        } else if (args.id && args.id.startsWith("kisskh:")) {
            const parts = args.id.split(":");
            episodeId = parts[2];
        }

        if (!episodeId) return { streams: [] };

        const streams = await getKisskhStream(episodeId);
        return { streams };
    } catch (e) {
        return { streams: [] };
    }
});

const addonInterface = builder.getInterface();

export default function (req, res) {
    addonInterface.get(req, res);
}

if (!process.env.VERCEL) {
    serveHTTP(addonInterface, { port: 7000 });
    console.log("🚀 Сървърът работи на: http://127.0.0.1:7000/manifest.json");
}
