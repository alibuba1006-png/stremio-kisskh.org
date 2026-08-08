const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const KISSKH_BASE = "https://kisskh.co";

const manifest = {
    id: "org.kisskh.stremio",
    version: "5.0.0",
    name: "KissKH Addon",
    description: "Гледай Азиатски сериали и филми от KissKH в Stremio (с поддръжка за OpenSubtitles)",
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

// --- BROWSER (Vercel & Local) ---
async function getBrowser() {
    if (process.env.VERCEL) {
        const puppeteerCore = require("puppeteer-core");
        const chromium = require("@sparticuz/chromium");
        return await puppeteerCore.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });
    } else {
        const puppeteer = require("puppeteer");
        return await puppeteer.launch({
            headless: "new",
            args: ["--no-sandbox", "--disable-setuid-sandbox"]
        });
    }
}

// --- ХЕЛПЪР ЗА НАМИРАНЕ НА IMDb ID (За да работят субтитрените добавки!) ---
async function findIMDbId(title, type) {
    try {
        const endpoint = type === "movie" ? "movie" : "series";
        const cleanTitle = title.replace(/\(\d{4}\)/g, "").trim(); // Премахва годината от заглавието за по-добро търсене
        const res = await axios.get(`https://v3-cinemeta.strem.io/catalog/${endpoint}/top/search=${encodeURIComponent(cleanTitle)}.json`);
        
        if (res && res.data && res.data.metas && res.data.metas.length > 0) {
            return res.data.metas[0].id; // Връща tt...
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
    const url = `${KISSKH_BASE}/api/DramaList/List?page=${page}&type=${kissType}&sub=0&country=0&status=0&order=2`;
    const response = await axios.get(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://kisskh.co/"
        },
        timeout: 10000
    });
    return response.data.data || [];
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

        // Автоматично намираме IMDb ID за заглавието!
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

        // Закачаме IMDb ID-то към метаданните (ако е намерено)!
        if (imdbId) {
            metaObj.imdb_id = imdbId;
        }

        return metaObj;
    } catch (error) {
        return null;
    }
}

// --- ПРЕХВАЩАНЕ НА СТРИЙМ ---
async function getKisskhStreamWithPuppeteer(dramaId, episodeId, epNumber) {
    let browser = null;
    let page = null;
    let streamUrl = null;
    let attempts = 0;

    try {
        browser = await getBrowser();
        page = await browser.newPage();

        await page.setRequestInterception(true);

        page.on("request", req => {
            const url = req.url();
            const resourceType = req.resourceType();

            if (url.includes(".m3u8") && !streamUrl) {
                streamUrl = url;
                req.continue();
            } else if (["image", "stylesheet", "font", "media"].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        const targetUrl = `${KISSKH_BASE}/Drama/Movie/Episode-${epNumber}?id=${dramaId}&ep=${episodeId}`;
        page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});

        while (!streamUrl && attempts < 25) {
            await new Promise(r => setTimeout(r, 150));
            attempts++;
        }

    } catch (err) {
        console.error("Puppeteer Error:", err.message);
    } finally {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }

    if (streamUrl) {
        return [{
            title: "KissKH HD Stream",
            url: streamUrl
        }];
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
    let dramaId, episodeId, epNumber = "1";

    if (args.id.startsWith("tt")) {
        const idParts = args.id.split(":");
        const imdbId = idParts[0];
        const requestedEpisode = idParts[2] || "1";

        // Заявка от Cinemeta
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
                    epNumber = targetEp.number.toString();
                }
            }
        }
    } else if (args.id.startsWith("kisskh:")) {
        const parts = args.id.split(":");
        dramaId = parts[1];
        episodeId = parts[2];
        epNumber = parts[3] || "1";
    }

    if (!dramaId || !episodeId) return { streams: [] };

    const streams = await getKisskhStreamWithPuppeteer(dramaId, episodeId, epNumber);
    return { streams };
});

// Vercel / Local
const addonInterface = builder.getInterface();
module.exports = (req, res) => {
    addonInterface.get(req, res);
};

if (!process.env.VERCEL) {
    serveHTTP(addonInterface, { port: 7000 });
    console.log("🚀 Сървърът с IMDb метаданни за субтитри работи на: http://127.0.0.1:7000/manifest.json");
}