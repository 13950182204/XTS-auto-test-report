#!/usr/bin/env node
/**
 * 残报告恢复：把中断轮次的报告目录（有 result/*.xml、缺 summary_report.xml）
 * 合成 summary 后归档到 <workbook>/report/<SUITE>/report-n（递增不覆盖）。
 * 用法：
 *   node xts_recover_report.mjs --from <报告目录> --workbook <设备目录> --suite acts
 * 出参：RECOVER_RESULT={"ok":…,"message":…,"archivedTo":…,"modules":…}
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { nextReportIndex, suiteArchiveName, synthesizeSummaryReport } from './xts_test_logic.mjs';
import { writeSynthesizedReportFiles } from './xts_report_writer.mjs';

const SUITES = ['ssts', 'hats', 'dcts', 'acts'];

function fail(message) {
  console.log(`RECOVER_RESULT=${JSON.stringify({ ok: false, message })}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = String(argv[i] ?? '').replace(/^--/, '');
    if (!key || argv[i + 1] === undefined) fail(`参数不完整：${argv[i]}`);
    args[key] = String(argv[i + 1] ?? '').trim();
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const from = path.resolve(args.from || '');
const workbookRoot = path.resolve(args.workbook || '');
const suite = String(args.suite || '').toLowerCase();

if (!SUITES.includes(suite)) fail(`--suite 只支持 ${SUITES.join('/')}，收到：${suite || '（空）'}`);
if (!await isDirectory(from)) fail(`报告目录不存在：${from}`);
if (!await isDirectory(workbookRoot)) fail(`设备目录不存在：${workbookRoot}`);
const resultDir = path.join(from, 'result');
if (!await isDirectory(resultDir)) fail(`报告目录里没有 result/（没有可恢复的模块结果）：${from}`);

const entries = await fs.readdir(resultDir).catch(() => []);
const xmlNames = entries.filter((name) => name.toLowerCase().endsWith('.xml'));
if (xmlNames.length === 0) fail(`result/ 目录是空的，没有可恢复的模块结果：${resultDir}`);

const existingSummary = await fs.readFile(path.join(from, 'summary_report.xml'), 'utf8').catch(() => '');
let synthesized = '';
if (!existingSummary) {
  const contents = await Promise.all(xmlNames.map((name) => fs.readFile(path.join(resultDir, name), 'utf8').catch(() => '')));
  synthesized = synthesizeSummaryReport(contents);
  if (!synthesized.includes('<testsuite')) fail('result XML 解析后没有可聚合的测试套件，恢复中止。');
}

const archiveRoot = path.join(workbookRoot, 'report', suiteArchiveName(suite));
const index = nextReportIndex(await fs.readdir(archiveRoot).catch(() => []));
const target = path.join(archiveRoot, `report-${index}`);
await fs.mkdir(archiveRoot, { recursive: true });
await fs.cp(from, target, { recursive: true });
let completion = { written: [], template: false };
if (!existingSummary) {
  completion = await writeSynthesizedReportFiles(target, {
    suite,
    command: `（恢复自 ${from}）`,
    sessionId: `${suite}-recovered`,
    workbookRoot,
    logPath: target,
  });
}

const modules = (await fs.readdir(path.join(target, 'result')).catch(() => [])).filter((name) => name.toLowerCase().endsWith('.xml')).length;
let suffix = '';
if (!existingSummary) {
  suffix = completion.template
    ? '（summary_report.xml 由 result XML 合成，含 summary_report.html / static / summary.ini 完整报告）'
    : '（summary_report.xml 由 result XML 合成）';
}
console.log(`RECOVER_RESULT=${JSON.stringify({
  ok: true,
  archivedTo: target,
  modules,
  synthesized: !existingSummary,
  fullReport: !existingSummary && completion.template,
  message: `已恢复 ${modules} 个已完成模块到 ${target}${suffix}。`,
})}`);

async function isDirectory(dir) {
  const stat = await fs.stat(dir).catch(() => undefined);
  return Boolean(stat?.isDirectory());
}
