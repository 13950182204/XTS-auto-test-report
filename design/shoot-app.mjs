import { chromium } from 'playwright';

const PORT = process.env.APP_PORT || '56771';
const BASE = `http://127.0.0.1:${PORT}/renderer/?port=${PORT}`;
const outDir = 'D:/ohos/xts-reporter-app/design';
const PAGES = ['概览', '测试盒子', '评测资料', 'XTS 自动测试', '镜像固件上传', '豁免资料', '设置'];

const browser = await chromium.launch().catch(async () => {
  for (const channel of ['msedge', 'chrome']) {
    try { return await chromium.launch({ channel }); } catch { /* 下一个 */ }
  }
  throw new Error('没有可用浏览器');
});

const errors = [];
async function shootAll(width, height, theme, suffix) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`[${width}] ${msg.text().slice(0, 120)}`); });
  page.on('pageerror', (error) => errors.push(`[${width}] pageerror: ${String(error).slice(0, 120)}`));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  await page.waitForTimeout(600);
  const loggedIn = await page.evaluate(() => !document.querySelector('.login'));
  if (!loggedIn) { console.log(`[${suffix}] 未登录（显示登录页），只截登录页`); await page.screenshot({ path: `${outDir}/app-${suffix}-login.png` }); await page.close(); return; }
  for (const label of PAGES) {
    const item = page.locator('.sidebar__item', { hasText: label }).first();
    await item.click();
    await page.waitForTimeout(450);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    await page.screenshot({ path: `${outDir}/app-${suffix}-${label}.png` });
    console.log(`[${suffix}] ${label} 截图完成${overflow ? ' ← 横向溢出!' : ''}`);
  }
  await page.close();
}

await shootAll(1440, 900, 'dark', 'dark1440');
await shootAll(1000, 760, 'dark', 'narrow1000');
await shootAll(1440, 900, 'light', 'light1440');
await browser.close();
console.log('console/page 错误：', errors.length === 0 ? '无' : '');
for (const e of errors.slice(0, 10)) console.log('  ', e);
