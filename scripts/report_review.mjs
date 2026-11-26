#!/usr/bin/env node
/**
 * 报告复审：核对一个设备目录的 `report/` 与 `exemption/` 是否满足兼容性提交要求。
 *
 * 规则（用户 2026-11-26）：
 *  ① 套件清单以「标准最小测试集_<有屏|无屏>…」为准，跑全、跑通才算过；
 *  ② 有屏幕/无屏幕由设备目录下 `OpenHarmony兼容性申请资料.xlsx` 的「是否带屏」决定；
 *  ③ 没通过的模块/用例必须在 `exemption/` 里找到对应豁免资料，否则复审不通过。
 *
 * 用法：
 *   node scripts/report_review.mjs --dir <设备目录> [--testcases <testcase 根>]
 * 输出（最后一行、单行 JSON）：
 *   REPORT_REVIEW_JSON=<json>
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { parseRunListLine, parseSummaryReport } from './xts_test_logic.mjs';

const RESULT_PREFIX = 'REPORT_REVIEW_JSON=';
const DEFAULT_TESTCASES = 'D:\\ohos\\XTS6.1\\testcase';
const WORKBOOK_NAME = 'OpenHarmony兼容性申请资料.xlsx';

/** 报告目录名 → 豁免目录候选名 / 最小测试集清单名。 */
const SUITES = [
  { key: 'acts', label: 'ACTS', report: 'ACTS', minFile: 'acts-min.txt', waiverDirs: ['Acts', 'ACTS'] },
  { key: 'validator', label: 'ACTS-VALIDATOR', report: 'ACTS-VALIDATOR', minFile: '', waiverDirs: ['ActsValidator', 'ACTS-VALIDATOR'] },
  { key: 'hats', label: 'HATS', report: 'HATS', minFile: 'hats-min.txt', waiverDirs: ['HATS', 'Hats'] },
  { key: 'dcts', label: 'DCTS', report: 'DCTS', minFile: 'dcts-min.txt', waiverDirs: ['DCTS', 'Dcts'] },
  { key: 'ssts', label: 'SSTS', report: 'SSTS', minFile: '', waiverDirs: ['SSTS', 'Ssts'] },
];

/**
 * 参考规模（用户给的基准，2026-11-26）：用于提示"这次跑的量明显不对"，
 * acts/hats/dcts 的期望模块数以最小测试集清单为准，不写死在这里。
 */
const REFERENCE = {
  validator: { tests: 162, modules: 1 },
  ssts: { tests: 82, modules: 23 },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i += 1;
  }
  return args;
}

const isDir = (p) => fs.stat(p).then((s) => s.isDirectory()).catch(() => false);
const isFile = (p) => fs.stat(p).then((s) => s.isFile()).catch(() => false);

/**
 * 读申请资料 xlsx 的「是否带屏」。
 * 坑：不同模板把值放在不同列（`是否带屏 | 带屏` 和 `是否带屏 |  | 带屏` 都出现过），
 * 所以扫整行取第一个非空单元格；表选择优先「测评编号已填写」的那张，避免读到模板空表。
 */
async function readScreenFromWorkbook(deviceDir) {
  const candidates = (await fs.readdir(deviceDir).catch(() => []))
    .filter((name) => /兼容性申请资料.*\.xlsx$/i.test(name) && !name.startsWith('~$'));
  if (candidates.length === 0) return { screen: '', source: '', note: `设备目录里没有 ${WORKBOOK_NAME}` };
  const file = path.join(deviceDir, candidates[0]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);

  const cellText = (cell) => {
    const value = cell?.value;
    if (value === null || value === undefined) return '';
    if (typeof value === 'object' && 'text' in value) return String(value.text ?? '').trim();
    if (typeof value === 'object' && 'result' in value) return String(value.result ?? '').trim();
    return String(value).trim();
  };

  // 判定顺序很重要：「不带屏」里含「带屏」，必须先判否定再判肯定。
  const isNoValue = (text) => /不带屏|无屏|^否$/.test(text);
  const isYesValue = (text) => /^不带屏$|无屏|^否$/.test(text) ? false : (/带屏|^是$/.test(text));

  const sheetInfo = [];
  for (const sheet of workbook.worksheets) {
    let certified = false;
    const screenValues = [];
    sheet.eachRow((row) => {
      const label = cellText(row.getCell(1));
      // 合并单元格会把标签复制到整片区域（实测 `是否带屏 | 是否带屏 | 不带屏…`），
      // 所以只收「不是标签、不是表头字段」的值，否则「是否带屏」会被当成「带屏」。
      const certifiedValue = cellText(row.getCell(2));
      if (/测评编号/.test(label) && certifiedValue && !/测评编号/.test(certifiedValue)) certified = true;
      if (!/是否带屏/.test(label)) return;
      for (let col = 1; col <= Math.max(row.cellCount, 1); col += 1) {
        const text = cellText(row.getCell(col));
        if (!text) continue;
        if (/是否带屏|测评编号|最近处理时间/.test(text)) continue;
        screenValues.push(text);
      }
    });
    let screen = '';
    if (screenValues.some(isYesValue)) screen = 'yes';
    else if (screenValues.some(isNoValue)) screen = 'no';
    sheetInfo.push({ name: sheet.name, certified, screen, screenValues });
  }

  const withScreen = sheetInfo.filter((item) => item.screen);
  const hit = withScreen.find((item) => item.certified) ?? withScreen[0];
  if (!hit) {
    const anySheet = sheetInfo.map((item) => item.name).join('/') || '无工作表';
    return { screen: '', source: file, note: `申请资料里「是否带屏」为空（工作表：${anySheet}）` };
  }
  return { screen: hit.screen, source: `${path.basename(file)}#${hit.name}`, note: '' };
}

/** 最小测试集目录：testcase 根的同级目录，按有屏/无屏挑。 */
async function resolveMinSetDir(testcasesRoot, screen) {
  const parent = path.dirname(testcasesRoot);
  const entries = await fs.readdir(parent).catch(() => []);
  const want = screen === 'no' ? '无屏' : '有屏';
  const hit = entries.find((name) => name.startsWith('标准最小测试集_') && name.includes(want));
  return hit ? path.join(parent, hit) : '';
}

/** 该套件最新一轮报告目录（report-N 里 N 最大）。 */
async function latestReport(suiteDir) {
  const names = (await fs.readdir(suiteDir).catch(() => []))
    .filter((name) => /^report-\d+$/.test(name))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  return names.length ? path.join(suiteDir, names[names.length - 1]) : '';
}

/** 报告轮次：report-N，按 N 升序。 */
async function reportRounds(suiteDir) {
  const names = (await fs.readdir(suiteDir).catch(() => []))
    .filter((name) => /^report-\d+$/.test(name))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  return names.map((name) => path.join(suiteDir, name));
}

/**
 * 逐模块取「最新一轮」结果：增量补测会让后面的轮次只含失败子集，
 * 所以已跑模块要看所有轮次的并集，而每个模块的结论以它最后出现的那一轮为准。
 */
async function collectModuleResults(rounds) {
  const byModule = new Map();
  for (const reportDir of rounds) {
    const resultDir = path.join(reportDir, 'result');
    const files = (await fs.readdir(resultDir).catch(() => [])).filter((name) => name.endsWith('.xml'));
    for (const name of files) {
      const text = await fs.readFile(path.join(resultDir, name), 'utf8').catch(() => '');
      if (!text) continue;
      const rootMatch = /<testsuites\b([^>]*)>/.exec(text);
      const attrs = rootMatch ? rootMatch[1] : '';
      const moduleName = (/\bname="([^"]+)"/.exec(attrs)?.[1] ?? name.replace(/\.xml$/, '')).trim();
      const failures = Number((/\bfailures="(\d+)"/.exec(attrs) ?? [])[1]);
      const tests = Number((/\btests="(\d+)"/.exec(attrs) ?? [])[1]);
      // 真失败 = result="false" 且 status="run"；status=disable/skip 是被忽略的用例，不算失败。
      const cases = [];
      const testsuites = [];
      for (const match of text.matchAll(/<testcase\b([^>]*)>/g)) {
        const a = match[1];
        const result = /result="([^"]*)"/.exec(a)?.[1] ?? '';
        const status = /status="([^"]*)"/.exec(a)?.[1] ?? '';
        if (result !== 'false' || status !== 'run') continue;
        const caseName = (/\bname="([^"]*)"/.exec(a)?.[1] ?? '').trim();
        const className = (/\bclassname="([^"]*)"/.exec(a)?.[1] ?? '').trim();
        if (caseName && !cases.includes(caseName)) cases.push(caseName);
        if (className && !testsuites.includes(className)) testsuites.push(className);
      }
      byModule.set(moduleName.toLowerCase(), {
        module: moduleName,
        failures: Number.isFinite(failures) ? failures : cases.length,
        tests: Number.isFinite(tests) ? tests : 0,
        cases,
        testsuites,
        reportDir,
      });
    }
  }
  return byModule;
}

/** 豁免目录里有没有这个条目（大小写不敏感；模块名或测试套名都算）。 */
async function findWaiver(waiverRoots, names) {
  for (const root of waiverRoots) {
    if (!await isDir(root)) continue;
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!names.some((name) => name && entry.name.toLowerCase() === name.toLowerCase())) continue;
      const dir = path.join(root, entry.name);
      const txt = (await fs.readdir(dir).catch(() => [])).filter((f) => f.toLowerCase().endsWith('.txt'));
      return { dir, reports: txt };
    }
  }
  return null;
}

async function reviewSuite({ suite, deviceDir, minSetDir, screen }) {
  const reportRoot = path.join(deviceDir, 'report', suite.report);
  const waiverRoots = suite.waiverDirs.map((name) => path.join(deviceDir, 'exemption', name));
  const result = {
    key: suite.key,
    label: suite.label,
    reportRoot,
    reportDir: '',
    rounds: 0,
    expectedModules: 0,
    expectedSource: '',
    referenceTests: 0,
    referenceModules: 0,
    ranModules: 0,
    tests: 0,
    failures: 0,
    missingModules: [],
    failedItems: [],
    exemptedItems: [],
    unexemptedItems: [],
    problems: [],
    warnings: [],
    ok: false,
  };

  // 无屏方案不含 DCTS 与 ACTS-VALIDATOR（用户 2026-11-26）：没有最小集、也不要求抽查，跳过不算缺。
  if (screen === 'no' && (suite.key === 'dcts' || suite.key === 'validator')) {
    result.ok = true;
    result.problems.push(suite.key === 'dcts' ? '无屏方案不含 DCTS' : '无屏方案不含 ACTS-VALIDATOR');
    return result;
  }

  // 期望模块清单：acts/hats/dcts 以最小测试集文件为准；validator/ssts 用参考规模提示。
  let expectedModules = [];
  if (suite.minFile && minSetDir) {
    const file = path.join(minSetDir, suite.minFile);
    if (await isFile(file)) {
      expectedModules = parseRunListLine(await fs.readFile(file, 'utf8'));
      result.expectedSource = path.relative(path.dirname(minSetDir), file);
    }
  }
  result.expectedModules = expectedModules.length;
  if (REFERENCE[suite.key]) {
    result.referenceTests = REFERENCE[suite.key].tests;
    result.referenceModules = REFERENCE[suite.key].modules;
    if (!result.expectedSource) result.expectedSource = '参考口径（无最小测试集文件）';
  }

  const rounds = await reportRounds(reportRoot);
  if (rounds.length === 0) {
    result.problems.push(`没有报告目录：${reportRoot}`);
    return result;
  }
  result.rounds = rounds.length;
  result.reportDir = rounds[rounds.length - 1];
  const summaryText = await fs.readFile(path.join(result.reportDir, 'summary_report.xml'), 'utf8').catch(() => '');
  if (!summaryText) {
    result.problems.push(`${path.basename(result.reportDir)} 缺少 summary_report.xml`);
    return result;
  }
  const summary = parseSummaryReport(summaryText);
  result.tests = Number((/<testsuites\b[^>]*\btests="(\d+)"/.exec(summaryText) ?? [])[1]) || 0;
  result.failures = summary.failures ?? 0;

  const modules = await collectModuleResults(rounds);
  result.ranModules = modules.size;

  // 缺失模块：最小集里有、所有轮次都没跑到。
  if (expectedModules.length > 0) {
    result.missingModules = expectedModules.filter((name) => !modules.has(name.toLowerCase()));
  }

  // 失败项 → 豁免覆盖（模块名 / 测试套名都作为豁免目录候选）
  for (const item of modules.values()) {
    if (!(item.failures > 0) && item.cases.length === 0) continue;
    const names = suite.key === 'validator' ? [...item.testsuites, item.module] : [item.module, ...item.testsuites];
    const waiver = await findWaiver(waiverRoots, names);
    const record = {
      module: item.module,
      testsuites: item.testsuites,
      caseCount: item.cases.length,
      cases: item.cases.slice(0, 40),
      failureCount: item.failures,
      round: path.basename(item.reportDir),
      waiverPath: waiver ? path.relative(deviceDir, waiver.dir) : '',
      waiverReports: waiver?.reports ?? [],
    };
    result.failedItems.push(record);
    if (waiver) result.exemptedItems.push(record);
    else result.unexemptedItems.push(record);
  }

  // 参考口径只用于提示：套件内容随版本变，数量不同不代表资料有问题，不能当阻塞。
  if (REFERENCE[suite.key]) {
    const ref = REFERENCE[suite.key];
    if (ref.tests && result.tests && result.tests !== ref.tests) {
      result.warnings.push(`用例数 ${result.tests}，参考口径 ${ref.tests}`);
    }
    if (ref.modules && result.ranModules && result.ranModules !== ref.modules) {
      result.warnings.push(`模块数 ${result.ranModules}，参考口径 ${ref.modules}`);
    }
  }
  if (result.missingModules.length > 0) {
    result.problems.push(`最小集里还有 ${result.missingModules.length} 个模块没跑到`);
  }
  if (result.unexemptedItems.length > 0) {
    result.problems.push(`${result.unexemptedItems.length} 个失败项没有豁免资料`);
  }
  result.ok = result.missingModules.length === 0 && result.unexemptedItems.length === 0;
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const emit = (value) => process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(value)}\n`);
  const deviceDir = args.dir ? path.resolve(String(args.dir)) : '';
  if (!deviceDir || !await isDir(deviceDir)) {
    emit({ ok: false, error: `设备目录不存在：${args.dir || '（未提供 --dir）'}` });
    return 0;
  }
  const testcasesRoot = path.resolve(String(args.testcases || DEFAULT_TESTCASES));

  const screenInfo = await readScreenFromWorkbook(deviceDir);
  const minSetDir = await resolveMinSetDir(testcasesRoot, screenInfo.screen);
  const suites = [];
  for (const suite of SUITES) {
    suites.push(await reviewSuite({ suite, deviceDir, minSetDir, screen: screenInfo.screen }));
  }
  const blocking = suites.filter((item) => !item.ok);
  emit({
    ok: true,
    deviceDir,
    screen: screenInfo.screen,
    screenSource: screenInfo.source,
    minSetDir,
    reference: REFERENCE,
    suites,
    verdict: blocking.length === 0 ? 'pass' : 'blocked',
    summary: {
      suites: suites.length,
      passed: suites.filter((item) => item.ok).length,
      blocked: blocking.length,
      unexempted: suites.reduce((sum, item) => sum + item.unexemptedItems.length, 0),
      warnings: suites.reduce((sum, item) => sum + item.warnings.length, 0),
      missingModules: suites.reduce((sum, item) => sum + item.missingModules.length, 0),
    },
    notes: [screenInfo.note].filter(Boolean),
  });
  return 0;
}

const scriptPath = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] ?? '') === path.resolve(scriptPath)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) })}\n`);
    process.exitCode = 1;
  });
}
