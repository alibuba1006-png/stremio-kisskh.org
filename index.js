const { addonBuilder } = require("stremio-addon-sdk");

const builder = new addonBuilder({
    id: "org.kisskh.org.clean",
    version: "1.0.0",
    name: "Clean KissKH Addon",
    description: "Напълно чист тестов аддон",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "test", name: "Test" }]
});

builder.defineCatalogHandler(() => {
    return { metas: [{ id: "1", type: "movie", name: "Работи!" }] };
});

const addonInterface = builder.getInterface();

module.exports = async (req, res) => {
    // ЗАДЪЛЖИТЕЛНИ HEADERS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    // МАНУАЛНО РЕШЕНИЕ ЗА MANIFEST
    if (req.url === '/manifest.json') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(addonInterface.manifest));
    }
    
    // ТЕСТОВ ОТГОВОР
    res.setHeader('Content-Type', 'text/plain');
    res.end('Addon server is running! Add /manifest.json to the link in Stremio.');
};
