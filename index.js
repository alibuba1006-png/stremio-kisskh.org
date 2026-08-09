const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer");

const HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://kisskh.org/"
};

const metaCache = new Map();
const streamCache = new Map();
let globalBrowser = null;

async function getBrowserInstance() {
    if (!globalBrowser || !globalBrowser.connected) {
        globalBrowser = await puppeteer.launch({ 
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--autoplay-policy=no-user-gesture-required'
            ] 
        });
    }
    return globalBrowser;
}

// 1. Дефиниране на Манифеста
const builder = new addonBuilder({
    id: "org.kisskh.org.universal.perfect",
    version: "19.0.0",
    name: "KissKH.org Perfect Addon",
    description: "Перфектен Addon с точна търсачка, реални епизоди и Cinemeta интеграция",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["kisskh_", "tt"],
    catalogs: [
        {
            type: "movie",
            id: "kisskh_movies",
            name: "KissKH.org Movies",
            extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }]
        },
        {
            type: "series",
            id: "kisskh_series",
            name: "KissKH.org Series",
            extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }]
        }
    ]
});

// 2. Каталог + Перфектна търсачка
builder.defineCatalogHandler(async function (args) {
    const skip = args.extra && args.extra.skip ? parseInt(args.extra.skip) : 0;
    const searchQuery = args.extra && args.extra.search ? args.extra.search.trim() : null;
    
    let baseUrl = "";
    if (searchQuery) {
        baseUrl = `https://kisskh.org/?s=${encodeURIComponent(searchQuery)}`;
        console.log(`\n[SEARCH] 🔍 Търсене за: "${searchQuery}" в категория: ${args.type}`);
    } else {
        const pageIndex = Math.floor(skip / 18) + 1;
        baseUrl = args.type === "movie" 
            ? (pageIndex === 1 ? "https://kisskh.org/movies/" : `https://kisskh.org/movies/page/${pageIndex}/`)
            : (pageIndex === 1 ? "https://kisskh.org/genre/drama/" : `https://kisskh.org/genre/drama/page/${pageIndex}/`);
    }

    let metas = [];

    try {
        const response = await axios.get(baseUrl, { headers: HTTP_HEADERS, timeout: 8000 });
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

// 3. МЕТАДАННИ (Увеличен timeout до 20 секунди за Render)
builder.defineMetaHandler(async function (args) {
    if (!args.id.startsWith("kisskh_")) return { meta: null };

    if (metaCache.has(args.id)) {
        return { meta: metaCache.get(args.id) };
    }

    const slug = Buffer.from(args.id.replace("kisskh_", ""), "base64").toString("utf-8");
    const fullUrl = `https://kisskh.org${slug}`;

    console.log(`\n[META] 🔍 Извличане за: ${fullUrl}`);

    let totalEpisodes = 0;
    let pageTitle = "KissKH Content";
    let description = "Няма описание.";
    let poster = "";
    let page = null;

    try {
        const browser = await getBrowserInstance();
        page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForSelector('.episode-item', { timeout: 10000 }).catch(() => {});

        const pageData = await page.evaluate(() => {
            const epCount = document.querySelectorAll('.episode-item').length;
            const titleText = document.querySelector('h1')?.innerText || document.title;
            const descText = document.querySelector('.wp-content p, .entry-content p')?.innerText || "";
            const posterSrc = document.querySelector('.poster img')?.src || "";

            return { epCount, titleText, descText, posterSrc };
        });

        pageTitle = pageData.titleText.replace(" - KissKH", "").trim();
        description = pageData.descText;
        poster = pageData.posterSrc;
        totalEpisodes = pageData.epCount;

        console.log(`[META] 🎯 УСПЕХ! Намерени ${totalEpisodes} епизода за: ${pageTitle}`);

    } catch (e) {
        console.error(`[ERROR Meta]:`, e.message);
        if (globalBrowser) {
            await globalBrowser.close().catch(() => {});
            globalBrowser = null;
        }
    } finally {
        if (page) await page.close().catch(() => {});
    }

    if (totalEpisodes === 0 && args.type === "series") {
        totalEpisodes = 12;
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

// 4. СТРИЙМОВЕ (Увеличен timeout до 25 секунди за Render)
builder.defineStreamHandler(async function (args) {
    let kisskhId = args.id;
    let episodeNumber = "1";

    if (args.id.startsWith("tt")) {
        const parts = args.id.split(":");
        const imdbId = parts[0];
        const requestedEp = parts[2] || "1";
        episodeNumber = requestedEp;

        console.log(`\n[IMDb Intercept] 🎬 Пуснато от Cinemeta ID: ${imdbId} (Епизод ${requestedEp})`);

        try {
            const cinemetaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/${args.type}/${imdbId}.json`);
            const meta = cinemetaRes.data?.meta;
            const title = meta?.name;
            const year = meta?.year;

            if (title) {
                console.log(`[IMDb Intercept] Търсене в KissKH за: "${title}" ${year ? `(${year})` : ""}`);
                
                let searchUrl = `https://kisskh.org/?s=${encodeURIComponent(title)}`;
                let searchRes = await axios.get(searchUrl, { headers: HTTP_HEADERS, timeout: 6000 });
                let $ = cheerio.load(searchRes.data);

                let matchedSlug = null;

                $("article, .item, .post, .result-item, .data h3 a").each((i, el) => {
                    if (matchedSlug) return;
                    const aTag = $(el).is("a") ? $(el) : $(el).find("a").first();
                    const href = aTag.attr("href");
                    
                    if (href && (href.includes("/movies/") || href.includes("/tvshows/") || href.includes("/drama/"))) {
                        matchedSlug = href;
                    }
                });

                if (!matchedSlug && year) {
                    searchUrl = `https://kisskh.org/?s=${encodeURIComponent(`${title} ${year}`)}`;
                    searchRes = await axios.get(searchUrl, { headers: HTTP_HEADERS, timeout: 6000 });
                    $ = cheerio.load(searchRes.data);

                    $("article, .item, .post, .result-item, .data h3 a").each((i, el) => {
                        if (matchedSlug) return;
                        const aTag = $(el).is("a") ? $(el) : $(el).find("a").first();
                        const href = aTag.attr("href");
                        if (href && (href.includes("/movies/") || href.includes("/tvshows/"))) {
                            matchedSlug = href;
                        }
                    });
                }

                if (matchedSlug) {
                    console.log(`[IMDb Intercept] 🎯 Намерен slug: ${matchedSlug}`);
                    const cleanSlug = matchedSlug.replace("https://kisskh.org", "").replace(/\/$/, "");
                    kisskhId = `kisskh_${Buffer.from(cleanSlug).toString("base64")}:1:${requestedEp}`;
                } else {
                    console.log(`[IMDb Intercept] ❌ Няма намерено заглавие в KissKH за "${title}".`);
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

    const formattedEp = episodeNumber.padStart(2, '0');
    const slug = Buffer.from(mainId.replace("kisskh_", ""), "base64").toString("utf-8");
    const episodeUrl = `https://kisskh.org${slug}/?episode=${formattedEp}`;

    console.log(`\n[STREAM] 🎬 Извличане на .mp4 за Епизод ${episodeNumber}: ${episodeUrl}`);

    let directMp4Url = null;
    let page = null;

    try {
        const browser = await getBrowserInstance();
        page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            if (url.includes('.mp4') || url.includes('.m3u8')) {
                directMp4Url = url;
            }
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(episodeUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

        await page.waitForFunction(() => {
            const video = document.querySelector('video');
            const source = document.querySelector('video source');
            return (video && video.src && video.src.includes('http')) || (source && source.src && source.src.includes('http'));
        }, { timeout: 15000 }).catch(() => {});

        if (!directMp4Url) {
            directMp4Url = await page.evaluate(() => {
                const v = document.querySelector('video');
                const s = document.querySelector('video source');
                return v?.src || s?.src || null;
            });
        }

    } catch (e) {
        console.error(`[STREAM Error]:`, e.message);
    } finally {
        if (page) await page.close().catch(() => {});
    }

    let streams = [];

    if (directMp4Url) {
        console.log(`[STREAM 🎯] УСПЕХ! Намерен директен .mp4 файл:\n=> ${directMp4Url}`);
        streams.push({
            name: "KissKH Player",
            title: `Гледай (KissKH Direct .MP4)`,
            url: directMp4Url,
            behaviorHints: {
                notSupportedInBrowser: false,
                proxyHeaders: {
                    request: {
                        "User-Agent": HTTP_HEADERS["User-Agent"],
                        "Referer": "https://kisskh.org/"
                    }
                }
            }
        });
    }

    if (directMp4Url) {
        streamCache.set(kisskhId, streams);
    }

    return { streams };
});

// Стартиране (С динамичен порт за Render)
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n====================================================`);
console.log(`>>> СЪРВЪРЪТ Е СТАРТИРАН УСПЕШНО НА ПОРТ ${PORT} <<<`);
console.log(`====================================================\n`);
