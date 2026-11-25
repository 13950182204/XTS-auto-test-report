/**
 * 残报告补全：把只有 log/ + result/ 的中断轮次报告目录补成完整 xdevice 报告
 * （summary_report.xml / summary.ini / task_info.record / static/data.js / summary_report.html）。
 * html 与静态资源是数据无关的 Vue 模板，从工作簿里任意一份完整报告拷贝；
 * 数据（summary_report.xml、data.js、ini、record）由 per-module result XML 合成。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildReportData, buildSummaryIni, buildTaskInfoRecord, synthesizeSummaryReport } from './xts_test_logic.mjs';

const ARCHIVE_SUITES = ['SSTS', 'HATS', 'DCTS', 'ACTS'];

function isFile(file) {
  return fs.stat(file).then((stat) => stat.isFile()).catch(() => false);
}

function isDirectory(dir) {
  return fs.stat(dir).then((stat) => stat.isDirectory()).catch(() => false);
}

export function hostInfo() {
  return `${String(os.type()).replace('Windows_NT', 'Windows')}-${os.release()}-SP0`;
}

/** 在工作簿的归档报告里找最近一份带 static/ + summary_report.html 的完整报告作为模板。 */
export async function findReportTemplate(workbookRoot) {
  for (const suite of ARCHIVE_SUITES) {
    const root = path.join(workbookRoot, 'report', suite);
    const names = (await fs.readdir(root).catch(() => []))
      .filter((name) => /^report-\d+$/.test(name))
      .sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)));
    for (const name of names) {
      const reportDir = path.join(root, name);
      const staticDir = path.join(reportDir, 'static');
      if (await isDirectory(staticDir) && await isFile(path.join(reportDir, 'summary_report.html'))
        && await isFile(path.join(staticDir, 'vue@3.2.41_global.min.js'))) {
        return { staticDir, html: path.join(reportDir, 'summary_report.html') };
      }
    }
  }
  return undefined;
}

/**
 * 把 reportDir 补全成完整报告（只写缺失的文件，不动已有产物）。
 * 返回 { written: string[], template: boolean, summaryXml: string }。
 */
export async function writeSynthesizedReportFiles(reportDir, { suite, command = '', sessionId = '', workbookRoot, logPath = '' }) {
  const resultDir = path.join(reportDir, 'result');
  const names = (await fs.readdir(resultDir).catch(() => [])).filter((name) => name.toLowerCase().endsWith('.xml'));
  const contents = (await Promise.all(names.map((name) => fs.readFile(path.join(resultDir, name), 'utf8').catch(() => ''))))
    .filter(Boolean);
  if (contents.length === 0) return { written: [], template: false, summaryXml: '' };

  const written = [];
  let summaryXml = await fs.readFile(path.join(reportDir, 'summary_report.xml'), 'utf8').catch(() => '');
  if (!summaryXml) {
    summaryXml = synthesizeSummaryReport(contents);
    await fs.writeFile(path.join(reportDir, 'summary_report.xml'), summaryXml, 'utf8');
    written.push('summary_report.xml');
  }

  const template = workbookRoot ? await findReportTemplate(workbookRoot) : undefined;
  if (template) {
    await fs.cp(template.staticDir, path.join(reportDir, 'static'), { recursive: true, force: true });
    await fs.copyFile(template.html, path.join(reportDir, 'summary_report.html'));
    written.push('static/', 'summary_report.html');
  } else {
    await fs.mkdir(path.join(reportDir, 'static'), { recursive: true });
  }

  const data = buildReportData(contents, { testType: String(suite ?? '').toUpperCase(), hostInfo: hostInfo() });
  for (const module of data.modules) {
    if (await isFile(path.join(reportDir, 'log', module.name, 'module_run.log'))) {
      module.logs = { 'module_run.log': `log/${module.name}/module_run.log` };
    }
  }
  if (await isFile(path.join(reportDir, 'log', 'task_log.log'))) {
    data.exec_info.logs = { 'task_log.log': 'log/task_log.log' };
  }
  await fs.writeFile(path.join(reportDir, 'static', 'data.js'), `window.reportData = ${JSON.stringify(data)}`, 'utf8');
  written.push('static/data.js');

  await fs.writeFile(path.join(reportDir, 'summary.ini'), buildSummaryIni({
    testType: String(suite ?? '').toUpperCase(),
    deviceName: data.devices.map((device) => device.sn).join(';'),
    hostInfo: hostInfo(),
    startTime: data.exec_info.test_start,
    endTime: data.exec_info.test_end,
    executionTime: data.exec_info.execute_time,
    logPath,
  }), 'utf8');
  written.push('summary.ini');

  const dataReports = Object.fromEntries(names.map((name) => [name.slice(0, -4), path.join(resultDir, name)]));
  await fs.writeFile(path.join(reportDir, 'task_info.record'), buildTaskInfoRecord({
    command,
    sessionId,
    reportPath: reportDir,
    dataReports,
  }), 'utf8');
  written.push('task_info.record');

  return { written, template: Boolean(template), summaryXml };
}
