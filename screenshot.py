import asyncio, sys
from playwright.async_api import async_playwright
tag = sys.argv[1] if len(sys.argv) > 1 else ''
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--autoplay-policy=no-user-gesture-required'])
        shots = [
            ('desktop', {'width':1440,'height':1000}, False, 'all', None),
            ('desktop-cricut', {'width':1440,'height':1000}, False, 'cricut', None),
            ('mobile', {'width':390,'height':844}, True, 'all', None),
            ('mobile-woodworking', {'width':390,'height':844}, True, 'wood', None),
        ]
        for name, vp, mob, cat, q in shots:
            ctx = await b.new_context(viewport=vp, device_scale_factor=2 if mob else 1, is_mobile=mob, has_touch=mob)
            pg = await ctx.new_page()
            url = f'http://localhost:8787/?cat={cat}'
            await pg.goto(url, wait_until='load', timeout=60000)
            await pg.wait_for_timeout(6000)
            await pg.screenshot(path=f'screenshots/{name}{tag}.png')
            await ctx.close()
        for cat in ['home', 'crafts']:
            ctx = await b.new_context(viewport={'width':1440,'height':1000}); pg = await ctx.new_page()
            await pg.goto(f'http://localhost:8787/?cat={cat}', wait_until='load', timeout=60000); await pg.wait_for_timeout(5000)
            await pg.screenshot(path=f'screenshots/desktop-{cat}{tag}.png'); await ctx.close()
        # search result: cricut tumbler (hits the YouTube Data API, cached 6h)
        ctx = await b.new_context(viewport={'width':1440,'height':1000}); pg = await ctx.new_page()
        await pg.goto('http://localhost:8787/?q=cricut%20tumbler', wait_until='load', timeout=60000)
        await pg.wait_for_timeout(8000)
        await pg.screenshot(path=f'screenshots/desktop-search-cricut-tumbler{tag}.png')
        await ctx.close()
        await b.close()
asyncio.run(main())
