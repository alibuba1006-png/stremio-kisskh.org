const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const { chromium } = require("playwright");

const HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Referer": "https://kisskh.org/"
};

const metaCache = new Map();
const streamCache = new Map();
let globalBrowser = null;

async function getBrowserInstance() {
    if (!globalBrowser || !globalBrowser.isConnected()) {
        globalBrowser = await chromium.launch({ 
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-infobars',
                '--window-size=1920,1080',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--autoplay-policy=no-user-gesture-required'
            ] 
        });
    }
    return globalBrowser;
}

// 1. Манифест
const builder = new addonBuilder({
    id: "org.kisskh.org.universal.playwright",
    version: "26.2.0",
    name: "KissKH.org Playwright Addon",
    description: "Оптимизиран KissKH Addon с подобрена стабилност",
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

// 2. Каталог
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
        const response = await axios.get(baseUrl, { headers: HTTP_HEADERS, timeout: 10000 });
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
        console.error(`[Catalog Error]:`, error.message);
    }

    return { metas };
});

// 3. МЕТАДАННИ (С увеличен timeout и по-меко зареждане)
builder.defineMetaHandler(async function (args) {
    if (!args.id.startsWith("kisskh_")) return { meta: null };

    if (metaCache.has(args.id)) {
        return { meta: metaCache.get(args.id) };
    }

    const slug = Buffer.from(args.id.replace("kisskh_", ""), "base64").toString("utf-8");
    const fullUrl = `https://kisskh.org${slug}`;

    let totalEpisodes = 0;
    let pageTitle = "KissKH Content";
    let description = "";
    let poster = "";
    let context = null;
    let page = null;

    try {
        const browser = await getBrowserInstance();
        context = await browser.newContext({
            userAgent: HTTP_HEADERS["User-Agent"]
        });
        page = await context.newPage();

        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        // Увеличен timeout на 15 секунди и използване на 'commit' за бързина
        await page.goto(fullUrl, { waitUntil: 'commit', timeout: 15000 });
        await page.waitForSelector('.episode-item', { timeout: 5000 }).catch(() => {});

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
    } catch (e) {
        console.error(`[Meta Error for ${slug}]:`, e.message);
    } finally {
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
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

// 4. СТРИЙМОВЕ (С увеличен timeout за линковете)
builder.defineStreamHandler(async function (args) {
    let kisskhId = args.id;
    let episodeNumber = "1";

    if (args.id.startsWith("tt")) {
        const parts = args.id.split(":");
        const imdbId = parts[0];
        const requestedEp = parts[2] || "1";
        episodeNumber = requestedEp;

        try {
            const cinemetaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/${args.type}/${imdbId}.json`, { timeout: 4000 });
            const title = cinemetaRes.data?.meta?.name;

            if (title) {
                let searchUrl = `https://kisskh.org/?s=${encodeURIComponent(title)}`;
                let searchRes = await axios.get(searchUrl, { headers: HTTP_HEADERS, timeout: 6000 });
                let $ = cheerio.load(searchRes.data);

                let matchedSlug = null;
                $("article, .item, .post").each((i, el) => {
                    if (matchedSlug) return;
                    const href = $(el).find("a").attr("href");
                    if (href && (href.includes("/movies/") || href.includes("/tvshows/") || href.includes("/drama/"))) {
                        matchedSlug = href;
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

    if (!kisskhId.startsWith("kisskh_")) return { streams: [] };

    if (streamCache.has(kisskhId)) {
        return { streams: streamCache.get(kisskhId) };
    }

    const idParts = kisskhId.split(":");
    const mainId = idParts[0];
    episodeNumber = idParts[2] || episodeNumber;

    const formattedEp = episodeNumber.padStart(2, '0');
    const slug = Buffer.from(mainId.replace("kisskh_", ""), "base64").toString("utf-8");
    const episodeUrl = `https://kisskh.org${slug}/?episode=${formattedEp}`;

    let directMp4Url = null;
    let context = null;
    let page = null;

    try {
        const browser = await getBrowserInstance();
        context = await browser.newContext({
            userAgent: HTTP_HEADERS["User-Agent"]
        });
        page = await context.newPage();

        page.on('request', (req) => {
            const url = req.url();
            if ((url.includes('.mp4') || url.includes('.m3u8')) && !url.includes('jwpltx.com') && !directMp4Url) {
                directMp4Url = url;
            } else if (url.includes('jwpltx.com') && url.includes('mu=') && !directMp4Url) {
                try {
                    const match = url.match(/mu=([^&]+)/);
                    if (match && match[1]) {
                        const decodedUrl = decodeURIComponent(match[1]);
                        if (decodedUrl.includes('.mp4') || decodedUrl.includes('.m3u8')) {
                            directMp4Url = decodedUrl;
                        }
                    }
                } catch (err) {}
            }
        });

        // Увеличен timeout на 20 секунди за епизодите
        await page.goto(episodeUrl, { waitUntil: 'commit', timeout: 20000 });
        await page.waitForTimeout(4000);

        if (!directMp4Url) {
            directMp4Url = await page.evaluate(() => {
                try {
                    if (window.jwplayer && window.jwplayer().getPlaylistItem) {
                        return window.jwplayer().getPlaylistItem().file;
                    }
                    const videoTag = document.querySelector('video');
                    if (videoTag && videoTag.src) return videoTag.src;

                    const sourceTag = document.querySelector('video source');
                    if (sourceTag && sourceTag.src) return sourceTag.src;
                } catch (e) {
                    return null;
                }
                return null;
            });
        }

    } catch (e) {
        console.error(`[Stream Error for ${episodeUrl}]:`, e.message);
    } finally {
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
    }

    let streams = [];
    if (directMp4Url) {
        streams.push({
            name: "KissKH Player",
            title: `Гледай (Direct MP4)`,
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
        streamCache.set(kisskhId, streams);
    }

    return { streams };
});

// Стартиране
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n>>> KISSKH СЪРВЪРЪТ РАБОТИ НА ПОРТ ${PORT} <<<\n`);
