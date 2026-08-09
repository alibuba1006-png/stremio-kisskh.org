const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

const HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://kisskh.org/"
};

const metaCache = new Map();
const streamCache = new Map();

// 1. Дефиниране на Манифеста
const builder = new addonBuilder({
    id: "org.kisskh.org.fast",
    version: "30.0.0",
    name: "KissKH.org Fast Addon",
    description: "Бърз Stremio аддон за KissKH без браузър и с Cinemeta интеграция",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["kisskh_", "tt"],
    catalogs: [
        {
            type: "movie",
            id: "kisskh_movies",
            name: "KissKH Movies",
            extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }]
        },
        {
            type: "series",
            id: "kisskh_series",
            name: "KissKH Series",
            extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }]
        }
    ]
});

// 2. Каталог + Търсачка (Супер бърза)
builder.defineCatalogHandler(async function (args) {
    const skip = args.extra && args.extra.skip ? parseInt(args.extra.skip) : 0;
    const searchQuery = args.extra && args.extra.search ? args.extra.search.trim() : null;
    
    let baseUrl = "";
    if (searchQuery) {
        baseUrl = `https://kisskh.org/?s=${encodeURIComponent(searchQuery)}`;
    } else {
        const pageIndex = Math.floor(skip / 18) + 1;
        baseUrl = args.type === "movie" 
            ? (pageIndex === 1 ? "https://kisskh.org/movies/" : `https://kisskh.org/movies/page/${pageIndex}/`)
            : (pageIndex === 1 ? "https://kisskh.org/genre/drama/" : `https://kisskh.org/genre/drama/page/${pageIndex}/`);
    }

    let metas = [];

    try {
        const response = await axios.get(baseUrl, { headers: HTTP_HEADERS, timeout: 6000 });
        const $ = cheerio.load(response.data);

        $("article").each((i, el) => {
            const article = $(el);
            const link = article.find("a").attr("href");
            if (!link) return;

            const isMovieLink = link.includes("/movies/");
            const isSeriesLink = link.includes("/tvshows/") || link.includes("/drama/");

            if (args.type === "movie" && !isMovieLink) return;
            if (args.type === "series" && !isSeriesLink) return;

            const imgEl = article.find("img");
            let title = imgEl.attr("alt") || article.find(".data h3 a, h3 a").text().trim();
            
            if (!title) {
                const slugPart = link.split("/").filter(Boolean).pop();
                title = slugPart ? slugPart.replace(/-/g, " ").toUpperCase() : "Unknown";
            }

            let poster = imgEl.attr("src") || imgEl.attr("data-src") || "";
            if (poster && poster.startsWith("//")) poster = "https:" + poster;

            if (link && title) {
                const cleanSlug = link.replace("https://kisskh.org", "").replace(/\/$/, "");
                const uniqueId = `kisskh_${Buffer.from(cleanSlug).toString("base64")}`;

                metas.push({
                    id: uniqueId,
                    type: args.type,
                    name: title,
                    poster: poster || "https://via.placeholder.com/300x450?text=No+Poster",
                    description: `KissKH | ${title}`
                });
            }
        });
    } catch (error) {
        console.error(`[ERROR Catalog]:`, error.message);
    }

    return { metas };
});

// 3. МЕТАДАННИ (Без чакане на браузър)
builder.defineMetaHandler(async function (args) {
    if (!args.id.startsWith("kisskh_")) return { meta: null };

    if (metaCache.has(args.id)) {
        return { meta: metaCache.get(args.id) };
    }

    const slug = Buffer.from(args.id.replace("kisskh_", ""), "base64").toString("utf-8");
    const fullUrl = `https://kisskh.org${slug}`;

    let totalEpisodes = 12; // Стандартен брой епизоди по подразбиране
    let pageTitle = "KissKH Content";
    let description = "Гледай в KissKH";
    let poster = "";

    try {
        const response = await axios.get(fullUrl, { headers: HTTP_HEADERS, timeout: 6000 });
        const $ = cheerio.load(response.data);

        pageTitle = $("h1").text().trim() || "KissKH Series";
        description = $(".wp-content p, .entry-content p").first().text().trim() || description;
        poster = $(".poster img").attr("src") || "";
        if (poster && poster.startsWith("//")) poster = "https:" + poster;

        const epItems = $(".episode-item").length;
        if (epItems > 0) {
            totalEpisodes = epItems;
        }
    } catch (e) {
        console.error(`[ERROR Meta]:`, e.message);
    }

    let videos = [];
    if (args.type === "series") {
        for (let epNum = 1; epNum <= totalEpisodes; epNum++) {
            videos.push({
                id: `${args.id}:1:${epNum}`,
                title: `Епизод ${epNum}`,
                season: 1,
                episode: epNum,
                released: new Date().toISOString()
            });
        }
    }

    const metaResult = {
        id: args.id,
        type: args.type,
        name: pageTitle,
        poster: poster,
        description: description,
        videos: videos.length > 0 ? videos : undefined
    };

    metaCache.set(args.id, metaResult);
    return { meta: metaResult };
});

// 4. СТРИЙМОВЕ
builder.defineStreamHandler(async function (args) {
    let kisskhId = args.id;
    let episodeNumber = "1";

    // Поддръжка на Cinemeta (IMDb ID)
    if (args.id.startsWith("tt")) {
        const parts = args.id.split(":");
        const imdbId = parts[0];
        const requestedEp = parts[2] || "1";
        episodeNumber = requestedEp;

        try {
            const cinemetaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/${args.type}/${imdbId}.json`);
            const meta = cinemetaRes.data?.meta;
            const title = meta?.name;

            if (title) {
                const searchUrl = `https://kisskh.org/?s=${encodeURIComponent(title)}`;
                const searchRes = await axios.get(searchUrl, { headers: HTTP_HEADERS, timeout: 5000 });
                const $ = cheerio.load(searchRes.data);

                let matchedSlug = null;
                $("article").each((i, el) => {
                    if (matchedSlug) return;
                    const href = $(el).find("a").attr("href");
                    if (href) {
                        const isMovie = href.includes("/movies/");
                        const isSeries = href.includes("/tvshows/") || href.includes("/drama/");
                        if (args.type === "movie" && isMovie) matchedSlug = href;
                        if (args.type === "series" && isSeries) matchedSlug = href;
                    }
                });

                if (matchedSlug) {
                    const cleanSlug = matchedSlug.replace("https://kisskh.org", "").replace(/\/$/, "");
                    kisskhId = `kisskh_${Buffer.from(cleanSlug).toString("base64")}:1:${requestedEp}`;
                }
            }
        } catch (e) {
            console.error(`[IMDb Error]:`, e.message);
        }
    }

    if (!kisskhId.startsWith("kisskh_")) {
        return { streams: [] };
    }

    if (streamCache.has(kisskhId)) {
        return { streams: streamCache.get(kisskhId) };
    }

    const idParts = kisskhId.split(":");
    const mainId = idParts[0];
    episodeNumber = idParts[2] || episodeNumber;

    const slug = Buffer.from(mainId.replace("kisskh_", ""), "base64").toString("utf-8");
    
    // Тъй като нямаме браузър, връщаме линк към страницата, където потребителят може да гледа директно, 
    // или опитваме да извлечем уеб плейъра ако е достъпен.
    const watchUrl = `https://kisskh.org${slug}/?episode=${episodeNumber.padStart(2, '0')}`;

    let streams = [{
        name: "KissKH Web",
        title: `Гледай Епизод ${episodeNumber} (Отвори в Браузър/Плейър)`,
        url: watchUrl,
        behaviorHints: {
            notSupportedInBrowser: false
        }
    }];

    streamCache.set(kisskhId, streams);
    return { streams };
});

const addonInterface = builder.getInterface();

// Съвместимост за Vercel или стандартен сървър
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    const url = req.url;
    if (url === '/' || url === '/manifest.json') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(addonInterface.manifest));
    }

    try {
        const parts = url.split('/').filter(Boolean);
        if (parts.length >= 3) {
            const resource = parts[0];
            const type = parts[1];
            let idOrExtra = parts[2].replace('.json', '');
            let extra = {};

            if (parts[3]) {
                const extraParts = parts[3].replace('.json', '').split('&');
                extraParts.forEach(p => {
                    const [k, v] = p.split('=');
                    if (k && v) extra[k] = decodeURIComponent(v);
                });
            }

            let result = null;
            if (resource === 'catalog') {
                result = await addonInterface.get('catalog', type, idOrExtra, extra);
            } else if (resource === 'meta') {
                result = await addonInterface.get('meta', type, idOrExtra);
            } else if (resource === 'stream') {
                result = await addonInterface.get('stream', type, idOrExtra);
            }

            if (result) {
                res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify(result));
            }
        }
        
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
        console.error(err);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
    }
};
