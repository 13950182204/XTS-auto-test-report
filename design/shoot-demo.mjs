import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = 'file:///' + path.join(here, 'ui-layout-demo.html').replaceAll('\\', '/');
const outDir = here;

const pages = ['overview', 'devices', 'materials', 'test', 'mirror', 'waiver', 'settings', 'login'];
const shots = [];
for (const page of pages) {
  shots.push({ name: `shot-a-${page}.png`, view: 'a', theme: 'dark', page });
  shots.push({ name: `shot-b-${page}.png`, view: 'b', theme: 'dark', page });
}
shots.push({ name: 'shot-light-materials.png', view: 'a', theme: 'light', page: 'materials' });
shots.push({ name: 'shot-light-test.png', view: 'b', theme: 'light', page: 'test' });

const browser = await chromium.launch().catch(async () => {
  for (const channel of ['msedge', 'chrome']) {
    try { return await chromium.launch({ channel }); } catch { /* 下一个 */ }
  }
  throw new Error('没有可用的浏览器（chromium / Edge / Chrome）');
});
const page = await browser.newPage({ viewport: { width: 1560, height: 940 } });
await page.goto(target);
for (const shot of shots) {
  await page.evaluate(([view, theme, targetPage]) => {
    document.documentElement.dataset.theme = theme;
    document.getElementById('stage').dataset.view = view;
    const set = (dir) => {
      const win = document.getElementById('win' + dir);
      win.dataset.page = targetPage;
      win.classList.toggle('win--login', targetPage === 'login');
      win.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.dataset.page === targetPage));
      win.querySelectorAll('.sidebar__item').forEach((b) => b.classList.toggle('active', b.dataset.page === targetPage));
    };
    set('A'); set('B');
    window.dispatchEvent(new Event('resize'));
  }, [shot.view, shot.theme, shot.page]);
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(outDir, shot.name) });
  console.log('saved', shot.name);
}
await browser.close();
