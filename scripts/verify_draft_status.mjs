import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { launchChromium } from './browser_launch.mjs';
import { signIn } from './fill_phase2.mjs';
import {
  discoverPhase2Workbooks,
  ensureWorkbookWritable,
  normalizeText,
  readPhase2Workbook,
  writeWorkbookState,
} from './phase2_logic.mjs';

/**
 * 草稿平台核验：登录兼容性测评平台，逐条核对「未提交草稿」在平台上的真实状态并回写工作簿。
 *
 * 背景：草稿列表是纯本地脱机的（只读工作簿状态），用户在平台上点完「确认提交」后
 * 工作簿仍停留在「第二阶段已保存」，面板会一直把已完成的申请显示成「未提交」。
 *
 * 判定（列表行为准，全部只读、不点任何会改平台状态的控件）：
 * - 列表搜不到测评编号 → 「平台列表未找到」（工作簿不动，可能已被平台清理）；
 * - 行内还有「编辑」按钮 → 平台仍可编辑，未提交（工作簿不动）；
 * - 行内没有「编辑」→ 读取行内状态文案回写工作簿：
 *   含 已完成/已提交/无需处理/已归档 → 从草稿面板消失；审核中/认证中等其它状态 → 如实回写展示。
 *
 * stdout 只有一行结果协议：
 *   PHASE2_VERIFY_JSON={"ok":true,"results":[…],"summary":{…},"message":"…"}
 */

const LOGIN_ENTRY_URL = 'https://compatibility.openharmony.cn/#/personal';
const VERIFICATION_MARKERS = /验证码|captcha|短信验证|手机验证|安全验证|人机验证/i;
const DONE_KEYWORDS = ['已完成', '已提交', '无需处理', '已归档'];
const NON_EDIT_KEYWORDS = [...DONE_KEYWORDS, '审核中', '认证中', '待审核', '待确认', '已受理'];
const POLL_SEARCH_MS = 800;

class VerifyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] || '' : '';
  };
  const input = value('--input') || value('--workbook');
  if (!input) throw new VerifyError('NO_INPUT', '没有提供设备目录或工作簿路径（--input），已停止执行。');
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const artifacts = value('--artifacts') || path.join(path.dirname(path.resolve(input)), `oh-draft-verify-${stamp}`);
  return { input, artifacts };
}

function emit(result) {
  console.log(`PHASE2_VERIFY_JSON=${JSON.stringify(result)}`);
}

async function writeResult(artifacts, result) {
  await fs.writeFile(path.join(artifacts, 'result.json'), `${JSON.stringify(result, null, 2)}\n`).catch(() => {});
}

async function screenshot(page, artifacts, name, redact = false) {
  if (redact) {
    await page.locator('input[type="password"], input[autocomplete="username"], input[placeholder="用户账号"]').evaluateAll((inputs) => {
      for (const input of inputs) {
        input.value = '';
        input.placeholder = '[redacted]';
      }
    }).catch(() => {});
  }
  await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true }).catch(() => {});
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }
  return null;
}

async function throwIfVerificationRequired(page, artifacts) {
  const text = await page.locator('body').innerText().catch(() => '');
  if (VERIFICATION_MARKERS.test(text)) {
    await screenshot(page, artifacts, 'human-verification-required', true);
    throw new VerifyError('HUMAN_VERIFICATION_REQUIRED', '检测到人工验证，未尝试绕过。');
  }
}

async function clickExactText(page, value) {
  const matches = page.getByText(value, { exact: true });
  for (let index = 0; index < await matches.count(); index += 1) {
    const match = matches.nth(index);
    if (await match.isVisible().catch(() => false)) {
      await match.click();
      return true;
    }
  }
  return false;
}

/** 与 fill_phase2.mjs 的 navigateToCertificationList 同款（选择器随平台页面走）。 */
async function navigateToCertificationList(page, artifacts) {
  if (page.url().includes('#/index')) return;
  const menuTitle = page.getByText('兼容性测评', { exact: true });
  let expanded = false;
  for (let index = 0; index < await menuTitle.count(); index += 1) {
    const item = menuTitle.nth(index);
    if (!await item.isVisible().catch(() => false)) {
      continue;
    }
    const title = item.locator('xpath=ancestor::div[contains(@class, "el-submenu__title")][1]');
    if (await title.isVisible().catch(() => false)) {
      await title.click();
      expanded = true;
      break;
    }
  }
  if (!expanded) {
    throw new VerifyError('COMPATIBILITY_MENU_NOT_FOUND', '无法展开兼容性测评菜单。');
  }
  await page.waitForTimeout(300);
  const listEntry = page.locator('li.el-menu-item.d3:visible').first();
  if (!await listEntry.isVisible().catch(() => false)) {
    throw new VerifyError('CERTIFICATION_LIST_NOT_FOUND', '未找到兼容性申请列表。');
  }
  await listEntry.click();
  await page.waitForURL(/#\/index(?:\?|$)/, { timeout: 15_000 });
  await page.waitForTimeout(500);
  await throwIfVerificationRequired(page, artifacts);
}

/** 在申请列表里按测评编号搜索并返回那一行（不点击任何行动作）。 */
async function findListRow(page, assessmentNumber) {
  const input = await firstVisible(page, ['input[placeholder="请输入测评编号"]']);
  if (!input) throw new VerifyError('ASSESSMENT_SEARCH_NOT_FOUND', '未找到测评编号查询框。');
  await input.fill('');
  await input.fill(assessmentNumber);
  if (!await clickExactText(page, '查询')) {
    throw new VerifyError('ASSESSMENT_SEARCH_ACTION_NOT_FOUND', '未找到查询控件。');
  }
  await page.waitForTimeout(POLL_SEARCH_MS);
  const rows = page.locator('table tbody tr');
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    if (normalizeText(await row.innerText().catch(() => '')).includes(assessmentNumber)) {
      return row;
    }
  }
  return null;
}

async function main() {
  let artifacts = '';
  try {
    const options = parseArgs(process.argv.slice(2));
    artifacts = options.artifacts;
    await fs.mkdir(artifacts, { recursive: true });
    const username = String(process.env.OH_USERNAME || '').trim();
    const password = String(process.env.OH_PASSWORD || '').trim();
    if (!username || !password) {
      throw new VerifyError('NO_CREDENTIALS', '没有填写对应账号密码，无法登录平台核验。');
    }

    const discovery = await discoverPhase2Workbooks(options.input);
    const drafts = [];
    for (const item of discovery.items) {
      try {
        const { record } = await readPhase2Workbook(item.workbookPath);
        const applicationId = String(record.applicationId || '').trim();
        const assessmentNumber = String(record.assessmentNumber || '').trim();
        if (!applicationId && !assessmentNumber) continue;
        if (DONE_KEYWORDS.some((keyword) => String(record.processingStatus || '').includes(keyword))) continue;
        drafts.push({ workbookPath: item.workbookPath, name: record.name || item.name, assessmentNumber, applicationId });
      } catch (error) {
        drafts.push({ workbookPath: item.workbookPath, name: item.name, assessmentNumber: '', applicationId: '', probeError: error instanceof Error ? error.message.split('；')[0] : String(error) });
      }
    }
    if (drafts.length === 0) {
      emit({ ok: true, results: [], summary: { updated: 0, unsubmitted: 0, notFound: 0, failed: 0 }, message: '没有需要核验的草稿。' });
      return;
    }

    // launchChromium 需要 playwright 模块做参数（与 fill_phase2.mjs 同款动态 import，
    // 静态解构在部分运行时会拿到 undefined）。
    const playwright = await import('playwright');
    const browser = await launchChromium(playwright, { headless: true });
    const results = [];
    try {
      const page = await browser.newPage();
      await signIn(page, options.artifacts, username, password);
      await navigateToCertificationList(page, options.artifacts);

      for (const draft of drafts) {
        const base = { workbookPath: draft.workbookPath, name: draft.name, assessmentNumber: draft.assessmentNumber, applicationId: draft.applicationId };
        if (draft.probeError) {
          results.push({ ...base, platformStatus: '跳过', updated: false, error: `工作簿读取失败：${draft.probeError}` });
          continue;
        }
        if (!draft.assessmentNumber) {
          results.push({ ...base, platformStatus: '跳过', updated: false, error: '没有测评编号，无法在平台列表定位。' });
          continue;
        }
        try {
          const row = await findListRow(page, draft.assessmentNumber);
          if (!row) {
            results.push({ ...base, platformStatus: '平台列表未找到', updated: false, note: '平台申请列表里搜不到这个测评编号（可能已被平台清理），工作簿未改动。' });
            continue;
          }
          const rowText = normalizeText(await row.innerText().catch(() => ''));
          const editable = await row.getByText('编辑', { exact: true }).first().isVisible().catch(() => false);
          if (editable) {
            results.push({ ...base, platformStatus: '未提交（平台仍可编辑）', updated: false });
            continue;
          }
          const keyword = NON_EDIT_KEYWORDS.find((item) => rowText.includes(item)) || '平台已受理（非编辑态）';
          const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
          await ensureWorkbookWritable(draft.workbookPath);
          await writeWorkbookState(draft.workbookPath, {
            status: keyword,
            processedAt: stamp,
            notes: `平台核验 ${stamp}：平台状态「${keyword}」。`,
          });
          results.push({ ...base, platformStatus: keyword, updated: true });
        } catch (error) {
          await screenshot(page, options.artifacts, `verify-${draft.assessmentNumber}-error`, true).catch(() => {});
          results.push({
            ...base,
            platformStatus: '核验失败',
            updated: false,
            error: error instanceof VerifyError ? error.message : `${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      const updated = results.filter((item) => item.updated).length;
      const unsubmitted = results.filter((item) => !item.updated && !item.error && String(item.platformStatus).includes('未提交')).length;
      const notFound = results.filter((item) => item.platformStatus === '平台列表未找到').length;
      const failed = results.filter((item) => item.error).length;
      const message = `平台核验完成：${updated} 条已更新工作簿状态，${unsubmitted} 条平台仍可编辑（未提交），${notFound} 条列表未找到${failed ? `，${failed} 条核验失败` : ''}。`;
      emit({ ok: failed === 0, results, summary: { updated, unsubmitted, notFound, failed }, message });
      writeResult(options.artifacts, { ok: true, results, summary: { updated, unsubmitted, notFound, failed } }).catch(() => {});
    } finally {
      await browser?.close();
    }
  } catch (error) {
    const message = error instanceof VerifyError ? error.message : `${error instanceof Error ? error.message : String(error)}`;
    emit({ ok: false, error: message });
    writeResult(artifacts, { ok: false, error: message }).catch(() => {});
    process.exitCode = 1;
  }
}

await main();
