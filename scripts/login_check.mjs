import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { launchChromium } from './browser_launch.mjs';
import { signIn } from './fill_phase2.mjs';

/**
 * 平台登录验证（只读）：真实登录一次兼容性测评平台，验证账号密码可用。
 * 登录成功即关闭浏览器退出，不导航、不写任何平台数据。
 *
 * stdout 只有一行结果协议：
 *   AUTH_JSON={"ok":true,"username":"…"} 或 {"ok":false,"error":"…"}
 */

const VERIFICATION_MARKERS = /验证码|captcha|短信验证|手机验证|安全验证|人机验证/i;

async function screenshot(page, artifacts, name, redact = false) {
  if (redact) {
    await page.locator('input[type="password"], input[placeholder="用户密码"]').evaluateAll((inputs) => {
      for (const input of inputs) {
        input.value = '';
        input.placeholder = '[redacted]';
      }
    }).catch(() => {});
  }
  await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true }).catch(() => {});
}

async function main() {
  let artifacts = '';
  try {
    const artifactIndex = process.argv.indexOf('--artifacts');
    artifacts = artifactIndex >= 0
      ? path.resolve(process.argv[artifactIndex + 1] || '')
      : path.join(process.cwd(), `oh-login-check-${Date.now()}`);
    await fs.mkdir(artifacts, { recursive: true });
    const username = String(process.env.OH_USERNAME || '').trim();
    const password = String(process.env.OH_PASSWORD || '').trim();
    if (!username || !password) {
      console.log(`AUTH_JSON=${JSON.stringify({ ok: false, error: '没有填写账号密码，无法验证登录。' })}`);
      process.exitCode = 1;
      return;
    }

    const playwright = await import('playwright');
    const browser = await launchChromium(playwright, { headless: true });
    try {
      const page = await browser.newPage();
      await signIn(page, artifacts, username, password);
      // signIn 内部已校验「登录后仍停留在密码页」与 OAuth 授权回调；走到这里即登录成功。
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (VERIFICATION_MARKERS.test(bodyText)) {
        await screenshot(page, artifacts, 'login-human-verification', true);
        console.log(`AUTH_JSON=${JSON.stringify({ ok: false, error: '登录触发人工验证（验证码/短信），未尝试绕过；请在浏览器里登录一次平台后再试。' })}`);
        process.exitCode = 1;
        return;
      }
      console.log(`AUTH_JSON=${JSON.stringify({ ok: true, username })}`);
    } finally {
      await browser?.close();
    }
  } catch (error) {
    const message = error instanceof Error ? `${error.message}`.replace(/\s+/g, ' ').trim() : String(error);
    console.log(`AUTH_JSON=${JSON.stringify({ ok: false, error: message })}`);
    process.exitCode = 1;
  }
}

await main();
