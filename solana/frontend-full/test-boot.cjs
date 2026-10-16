const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const logs = [];
    page.on('console', m => { const t = m.text(); if (!/429|Failed to load resource/.test(t)) logs.push(`[${m.type()}] ${t}`); });
    page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
    await page.goto('http://localhost:8000/app.html', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('NAV:', e.message));
    await page.waitForTimeout(45000);
    const sel = await page.evaluate(() => {
        const s = document.getElementById('mint-vault-select');
        return { opts: s ? [...s.options].map(o => o.value.slice(0, 16)) : null, sel: s?.value || null };
    }).catch(e => ({ evalErr: e.message }));
    console.log(JSON.stringify(sel));
    console.log('=== LOGS ===');
    logs.slice(-50).forEach(l => console.log(l.slice(0, 220)));
    await browser.close();
    process.exit(0);
})();
