const { addonBuilder } = require("stremio-addon-sdk");

const builder = new addonBuilder({
    id: "org.kisskh.org.test",
    version: "1.0.0",
    name: "KissKH Test Addon",
    description: "Тестов аддон",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [
        {
            type: "movie",
            id: "test_catalog",
            name: "Test Catalog"
        }
    ]
});

builder.defineCatalogHandler(async (args) => {
    return { metas: [{ id: "test_1", type: "movie", name: "Test Movie" }] };
});

const addonInterface = builder.getInterface();

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // ВРЪЩАМЕ МАНИФЕСТА ДИРЕКТНО
    if (req.url === '/manifest.json' || req.url === '/') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(addonInterface.manifest));
    }
    
    // ЗА КАТАЛОГА
    if (req.url.includes('catalog')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(await addonInterface.get('catalog', 'movie', 'test_catalog')));
    }

    res.statusCode = 404;
    res.end('Not Found');
};
