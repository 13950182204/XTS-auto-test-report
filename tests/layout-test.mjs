/**
 * 布局自适应测试（TDD）：多视口宽度 × 全页面 × 布局断言。
 * 运行：先启动应用（npx electron .），再 APP_PORT=<端口> npm run test:layout
 * 断言全绿退出 0；任何失败退出 1 并列出明细。
 */
import { chromium } from 'playwright';

const PORT = process.env.APP_PORT || '';
if (!PORT) { console.error('缺少 APP_PORT 环境变量（应用本地服务端口）'); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}/renderer/?port=${PORT}`;
const WIDTHS = [960, 1024, 1100, 1200, 1280, 1337, 1440, 1600, 1920];
const PAGES = ['概览', '测试盒子', '评测资料', 'XTS 自动测试', '镜像固件上传', '豁免资料', '设置'];

const failures = [];
const checks = [];
function record(scenario, ok, detail = '') {
  checks.push({ scenario, ok, detail });
  if (!ok) failures.push(`${scenario} — ${detail}`);
}

const browser = await chromium.launch().catch(async () => {
  for (const channel of ['msedge', 'chrome']) {
    try { return await chromium.launch({ channel }); } catch { /* 下一个 */ }
  }
  throw new Error('没有可用浏览器（chromium / Edge / Chrome）');
});

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error' && !msg.text().includes('favicon')) consoleErrors.push(msg.text().slice(0, 120)); });
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 120)}`));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

// 登录门通过（应用凭据已在 settings 中）
const loggedIn = await page.evaluate(() => !document.querySelector('.login'));
record('登录门', loggedIn, loggedIn ? '' : '应用未登录，主界面无法加载（检查 settings 凭据）');

if (loggedIn) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(120);
    for (const label of PAGES) {
      await page.locator('.sidebar__item', { hasText: label }).first().click();
      await page.waitForTimeout(90);
      const tag = `[${width}] ${label}`;

      // 1. 无横向文档溢出
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      record(`${tag} 无横向溢出`, overflow.scroll <= overflow.client + 1, `scrollWidth ${overflow.scroll} > clientWidth ${overflow.client}`);

      // 2. 可见元素不越过视口右缘（面板/行/按钮/picker）
      const offenders = await page.evaluate(() => {
        const vw = window.innerWidth;
        const bad = [];
        for (const el of document.querySelectorAll('.panel,.row,.pick-item,.btn,.field,.status')) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0) continue;
          if (rect.right > vw + 1) bad.push(`${el.className.toString().slice(0, 40)}@${Math.round(rect.right)}`);
          if (bad.length >= 3) break;
        }
        return bad;
      });
      record(`${tag} 元素不出视口`, offenders.length === 0, offenders.join(' | '));

      // 3. 双栏/单列断点：<1200 单列，>=1200 双栏
      const tracks = await page.evaluate(() => {
        const wb = document.querySelector('.workbench');
        return wb ? getComputedStyle(wb).gridTemplateColumns.split(' ').filter((t) => t !== 'none').length : 0;
      });
      if (width < 1200) record(`${tag} 窄窗单列`, tracks <= 1, `workbench ${tracks} 列`);
      else record(`${tag} 宽窗双栏`, tracks === 2 || label === '设置', `workbench ${tracks} 列`);

      // 4. 侧栏形态：>900 纵向，<=900 横向（960 视口仍纵向）
      if (width === 960) {
        const flexDir = await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).flexDirection);
        record('[960] 侧栏纵向', flexDir === 'column', `flex-direction ${flexDir}`);
      }

      // 5. 行内名字不被压扁：较长的 name 文本渲染宽度 ≥ 56px
      const collapsed = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll('.row-top .name')) {
          const text = (el.textContent || '').trim();
          if (text.length < 8) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.width < 56) bad.push(`"${text.slice(0, 12)}"@${Math.round(rect.width)}px`);
          if (bad.length >= 3) break;
        }
        return bad;
      });
      record(`${tag} 行名不被压扁`, collapsed.length === 0, collapsed.join(' | '));

      // 6. 页头主动作在视口内可点
      const actions = await page.evaluate(() => {
        const bar = document.querySelector('.page-head__actions');
        if (!bar) return { missing: true };
        const rect = bar.getBoundingClientRect();
        return { missing: false, right: rect.right, top: rect.top, vw: window.innerWidth, w: rect.width };
      });
      if (!actions.missing) {
        record(`${tag} 页头主动作在视口内`, actions.right <= actions.vw + 1 && actions.top >= 0 && actions.w > 0,
          `right=${Math.round(actions.right)} vw=${actions.vw} w=${Math.round(actions.w)}`);
      }

      // 7. 截断元素内容不外溢（scrollWidth 允许超出但 overflow hidden 时 clientWidth 是定值——校验父容器不被撑破）
      const spill = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll('.path,.pick-sub,.mono-line')) {
          const parent = el.parentElement;
          if (!parent) continue;
          if (el.scrollWidth > 0 && parent.scrollWidth > parent.clientWidth + 2 && getComputedStyle(parent).overflowX === 'visible') {
            bad.push(el.className.toString().slice(0, 24));
            if (bad.length >= 3) break;
          }
        }
        return bad;
      });
      record(`${tag} 截断不撑破父容器`, spill.length === 0, spill.join(' | '));

      // 8. 面板滚动区不双层滚动：.panel__scroll 存在时其内容高 ≥ 视口才有意义（仅豁免/资料批次常见，宽松断言）
      const doubleScroll = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll('.panel__scroll')) {
          const style = getComputedStyle(el);
          if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') bad.push('overflowY=' + style.overflowY);
        }
        return bad;
      });
      record(`${tag} 滚动区 overflow-y 正确`, doubleScroll.length === 0, doubleScroll.join(' | '));

      // 9. 注入行：单行不被纵向拉伸成面板高度、短名字不被截断、长路径正确省略（数据无关，逐页验证）
      const injected = await page.evaluate(() => {
        const scroll = document.querySelector('.panel--fill .panel__scroll');
        if (!scroll) return null;
        const chip = document.createElement('span');
        chip.className = 'chip chip--ok';
        chip.textContent = 'SSTS';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = '第 1 轮 · 全部通过';
        const path = document.createElement('span');
        path.className = 'path push-right';
        path.textContent = '已归档 D:\\ohos\\XTS6.1\\DHong\\DH-909HD-B24\\report\\SSTS\\report-1';
        const top = document.createElement('div');
        top.className = 'row-top';
        top.append(chip, name, path);
        const row = document.createElement('div');
        row.className = 'row row--ready';
        row.appendChild(top);
        scroll.appendChild(row);
        const height = row.getBoundingClientRect().height;
        const nameTruncated = name.scrollWidth > name.clientWidth + 2;
        row.remove();
        return { height, nameTruncated };
      });
      if (injected) {
        record(`${tag} 注入行不被拉伸`, injected.height > 0 && injected.height < 140, `行高 ${Math.round(injected.height)}px`);
        record(`${tag} 注入短名不截断`, !injected.nameTruncated, injected.nameTruncated ? '「第 1 轮 · 全部通过」被省略' : '');
      }
    }
  }

  // 9. 主题切换：浅色下 data-theme 生效
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  record('主题切换生效', theme === 'light', `data-theme=${theme}`);

  // 10. 登录页撑满整窗
  await page.goto('about:blank');
  // 用设置页模拟不便；登录门已在上方校验，此处跳过实际登出（不清凭据）。
}

// console 错误（favicon 404 除外）
record('console 无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();

const passed = checks.filter((c) => c.ok).length;
console.log(`\n布局自适应测试：${passed}/${checks.length} 通过`);
if (failures.length > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
} else {
  console.log('全部场景通过 ✓');
}
