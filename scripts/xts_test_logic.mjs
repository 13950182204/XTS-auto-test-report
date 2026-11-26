import path from 'node:path';

/**
 * XTS 自动测试的纯逻辑层（供 `xts_run_test.mjs` 与 vitest 共用）。
 *
 * 这里只放「给一段文本/一组名字，返回一个结果」的纯函数，不做任何 IO，
 * 便于单测覆盖边界情况；套件目录扫描、子进程编排都在 `xts_run_test.mjs`。
 */

/** 被测设备 SN 的统一形态：解析用户输入（换行 / 分号 / 逗号 / 全角分号逗号 / 空白均可）成去重后的数组。 */
export function parseSnsInput(value) {
  const raw = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  const seen = new Set();
  const result = [];
  for (const token of raw.split(/[\n\r;,；，\s]+/)) {
    const sn = token.trim();
    if (!sn || seen.has(sn)) continue;
    seen.add(sn);
    result.push(sn);
  }
  return result;
}

/** 多设备并行的 xdevice 参数形态：`SN1;SN2`（env_pool.py 按 `;` 切分）。 */
export function joinSns(sns) {
  return parseSnsInput(sns).join(';');
}

/**
 * 解析「标准最小测试集」清单行。文件内容是一行 `run -l A;B;C`（也可能被手工
 * 去掉过前缀或改成多行），这里统一兼容：剥掉 `run`/`-l` 前缀后按 `;` 切分。
 */
export function parseRunListLine(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const modules = [];
  for (const line of lines) {
    let token = line.trim();
    if (!token || token.startsWith('#')) continue;
    token = token.replace(/^run\s+(?:-l\s+|--testlist\s+)/i, '');
    token = token.replace(/^-l\s+/i, '');
    for (const item of token.split(';')) {
      const module = item.trim();
      if (module && !modules.includes(module)) modules.push(module);
    }
  }
  return modules;
}

/**
 * 生成临时 user_config.xml：以套件自带配置为模板，把**含 <sn> 的第一个 <device> 块**的
 * `<sn>` 换成用户填写的 SN 列表（分号分隔 = 多设备并行），其余含 SN 的 <device> 块
 * 整体移除（避免把模板里写死的其它样机也拉进设备池）。注意 `<support_device>` 里的
 * `<device>true</device>` 是开关不是设备，必须原样保留。找不到含 <sn> 的设备块时报中文错。
 */
export function buildUserConfig(templateXml, sns) {
  const list = parseSnsInput(sns);
  if (list.length === 0) throw new Error('没有可用的设备 SN，无法生成测试配置。');
  const source = String(templateXml ?? '');
  const devicePattern = /<device\b[^>]*>[\s\S]*?<\/device>/g;
  const snBlocks = [...source.matchAll(devicePattern)].filter((match) => /<sn\b/.test(match[0]));
  if (snBlocks.length === 0) {
    throw new Error('套件 user_config.xml 里没有含 <sn> 的 <device> 配置块，无法替换设备 SN。');
  }
  const snPattern = /<sn\b[^>]*\/>|<sn\b[^>]*>[\s\S]*?<\/sn>/;
  let output = '';
  let cursor = 0;
  snBlocks.forEach((match, index) => {
    output += source.slice(cursor, match.index);
    output += index === 0
      ? match[0].replace(snPattern, `<sn>${list.join(';')}</sn>`)
      : '';
    cursor = match.index + match[0].length;
  });
  output += source.slice(cursor);
  return output;
}

/**
 * 在测试用例根目录的同级目录里定位「标准最小测试集」目录。
 * screen 传 'no'（无屏）或 'yes'（有屏），返回目录名；找不到返回 undefined。
 */
export function resolveMinSetDirName(entries, screen) {
  const prefix = screen === 'no' ? '标准最小测试集_无屏' : screen === 'yes' ? '标准最小测试集_有屏' : '';
  if (!prefix) return undefined;
  const names = Array.isArray(entries) ? entries : [];
  return names.find((name) => typeof name === 'string' && name.startsWith(prefix)) || undefined;
}

function tagAttributes(tagText) {
  const attrs = {};
  const pattern = /([A-Za-z_][\w:-]*)\s*=\s*"([^"]*)"/g;
  for (const match of String(tagText ?? '').matchAll(pattern)) attrs[match[1]] = match[2];
  return attrs;
}

/**
 * 判卷 summary_report.xml（regex 提取，避免引依赖）。
 * - 根节点 `<testsuites failures="0" … modules="N" runmodules="N">` 是整体结论；
 * - 每个 `<testsuite … failures="1" modulename="ActsXxx">` 的 modulename 是失败模块；
 * - **整模块用例全部 ignored（ignored ≥ tests > 0）= 没真正跑到**，也计入失败模块
 *   （实测 dcts 环境没就绪时整模块 ignored、failures 仍是 0，不能当"通过"）；
 * - **unavailable（模块没跑起来，tests=0）也算失败**，模块名计入 failedModules 进补测
 *   （实测 ssts 的 OpenHarmony-SA-Patch-label-test 在部分设备上 unavailable，必须重测）；
 * - 正常的少量 ignored 用例不影响通过。
 */
export function parseSummaryReport(xml) {
  const text = String(xml ?? '');
  const rootMatch = text.match(/<testsuites\b([^>]*)>/);
  const root = rootMatch ? tagAttributes(rootMatch[1]) : {};
  const failedModules = [];
  const suitePattern = /<testsuite\b([^>]*)>/g;
  for (const match of text.matchAll(suitePattern)) {
    const attrs = tagAttributes(match[1]);
    const failures = Number(attrs.failures);
    const tests = Number(attrs.tests);
    const ignored = Number(attrs.ignored);
    const moduleName = (attrs.modulename || attrs.name || '').trim();
    if (!moduleName) continue;
    const hasFailures = Number.isFinite(failures) && failures > 0;
    const allIgnored = Number.isFinite(tests) && tests > 0 && Number.isFinite(ignored) && ignored >= tests;
    const noTests = Number.isFinite(tests) && tests === 0;
    if (!hasFailures && !allIgnored && !noTests) continue;
    if (!failedModules.includes(moduleName)) failedModules.push(moduleName);
  }
  const total = Number(root.modules);
  const runModules = Number(root.runmodules);
  return {
    total: Number.isFinite(total) ? total : undefined,
    runModules: Number.isFinite(runModules) ? runModules : undefined,
    failures: Number.isFinite(Number(root.failures)) ? Number(root.failures) : undefined,
    unavailable: Number.isFinite(Number(root.unavailable)) ? Number(root.unavailable) : undefined,
    failedModules,
    ok: (Number(root.failures) || 0) === 0 && (Number(root.unavailable) || 0) === 0
      && failedModules.length === 0,
  };
}

/**
 * 兜底判卷 task_info.record（JSON）：`unsuccessful_params` 的 key 就是失败模块。
 * 运行中/文件不完整时返回 undefined，调用方继续等 summary_report.xml。
 */
export function parseTaskInfoRecordText(text) {
  try {
    const value = JSON.parse(String(text ?? ''));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const unsuccessful = value.unsuccessful_params;
    if (unsuccessful === null || typeof unsuccessful !== 'object' || Array.isArray(unsuccessful)) return undefined;
    return Object.keys(unsuccessful).filter((name) => typeof name === 'string' && name.trim() !== '');
  } catch {
    return undefined;
  }
}

/**
 * 有屏判定：`hdc shell hidumper -s RenderService -a screen` 的输出里
 * 出现 `screen[0]` 条目即有屏（无屏设备没有该条目）。
 */
export function parseHdcScreenOutput(text) {
  return /screen\[0\]/i.test(String(text ?? '')) ? 'yes' : 'no';
}

/** `hdc list targets` 输出 → 在线 SN 数组（忽略空行与提示文本；SN 形态含 IP:port）。 */
export function parseHdcTargets(text) {
  const result = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const token = line.trim();
    if (!token || token.includes(' ') || token.includes('\t')) continue;
    if (/^[0-9A-Za-z:._-]+$/.test(token) && !result.includes(token)) result.push(token);
  }
  return result;
}

/**
 * xdevice 进度行：`[1 / 342] Executing: D:\...\ActsXxx.json, Device: <sn>`。
 * index 是「已开始执行的模块序号」（多设备并行推进），不是完成数；完成数由调用方
 * 另行统计 result/*.xml。非进度行返回 undefined。
 */
export function parseXdeviceExecLine(line) {
  const match = String(line ?? '').match(/\[\s*(\d+)\s*\/\s*(\d+)\s*\]\s*Executing:\s*(.+?),\s*Device:\s*([^,\]]+)/);
  if (!match) return undefined;
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(index) || !Number.isFinite(total)) return undefined;
  const moduleFile = match[3].trim();
  // 模块路径可能是 Windows 反斜杠形式：统一归一成 / 再取 basename（POSIX 宿主/测试也能解析）。
  const moduleName = path.basename(moduleFile.replaceAll('\\', '/')).replace(/\.json$/i, '');
  return { index, total, module: moduleName, device: match[4].trim() };
}

/**
 * 报告归档编号：扫既有的 `report-1 … report-n` 取 max+1，永不覆盖（首轮为 report-1）。
 * 只认 `report-<纯数字>`，其余名字（如 report.zip）不参与。
 */
export function nextReportIndex(existingNames) {
  let max = 0;
  for (const name of Array.isArray(existingNames) ? existingNames : []) {
    const match = /^report-(\d+)$/i.exec(String(name ?? '').trim());
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max + 1;
}

/**
 * 有屏 HATS 需要拆出的 HDF 模块（单独增量报告，主轮不跑）。
 */
export const HDF_MODULES = Object.freeze([
  'HatsHdfInputPassthroughAdditionalTest',
  'HatsHdfInputPassthroughTest',
  'HatsHdfInputTest',
]);

/**
 * 测试方案：串行顺序固定 ssts → hats → dcts(仅有屏) → acts。
 * - ssts / dcts **单机执行**（singleDevice：只取第一台 SN，不参与多机并行）；
 * - dcts 跑前要执行套件 resource/ 下的 `dcts_resource.bat` 安装测试工具（执行时按
 *   `<套件>_resource.bat` 通用探测，ssts 的 resource 只有工具 hap、无 bat）；
 * - 有屏时 hats 拆两步：主轮（不含 HDF）+ HATS-HDF 增量（只有 HDF 模块，单独归档）。
 */
export function suitePlan(screen) {
  const plan = [
    { suite: 'ssts', mode: 'task', singleDevice: true },
    { suite: 'hats', mode: 'list', minFile: 'hats-min.txt' },
  ];
  if (screen === 'yes') {
    plan.push({ suite: 'hats', mode: 'list', minFile: 'hats-min.txt', hdfOnly: true, singleDevice: true, hdfLabel: 'HATS-HDF' });
    plan.push({ suite: 'dcts', mode: 'list', minFile: 'dcts-min.txt', singleDevice: true });
  }
  plan.push({ suite: 'acts', mode: 'list', minFile: 'acts-min.txt' });
  return plan;
}

/** 从模块清单里剔除 HDF 模块（主轮 HATS 用）。 */
export function excludeHdfModules(modules) {
  const hdfSet = new Set(HDF_MODULES.map((m) => m.toLowerCase()));
  return modules.filter((m) => !hdfSet.has(m.toLowerCase()));
}

/** 从模块清单里只取 HDF 模块（HATS-HDF 增量轮用）。 */
export function filterHdfModules(modules) {
  const hdfSet = new Set(HDF_MODULES.map((m) => m.toLowerCase()));
  return modules.filter((m) => hdfSet.has(m.toLowerCase()));
}

/**
 * 单个 plan step 的报告根目录标签：主轮与 HATS-HDF 增量轮同为 suite=hats，
 * 必须用不同标签（hats-rN vs hats-hdf-rN），否则增量轮会复用主轮的 xdevice
 * 报告目录、判卷读到旧报告「假通过」（2026-11-23 实测 175+3 只归档了 175 的根因）。
 */
export function stepReportTag(step) {
  return `${step.suite}${step.hdfOnly ? '-hdf' : ''}`;
}

/** 套件目录名 → 归档目录名（report/SSTS/report-1 的对应路径，沿用现有大写约定）。 */
export function suiteArchiveName(suite) {
  return { ssts: 'SSTS', hats: 'HATS', 'hats-hdf': 'HATS', dcts: 'DCTS', acts: 'ACTS' }[suite] || String(suite).toUpperCase();
}

/** 测试盒子 SN 缺省值（DCTS 前置连通预检；与宿主 DEFAULT_TEST_BOX_SN 同值）。 */
export const DEFAULT_TEST_BOX_SN = '370100654d4d43202010000071dd7b00';

/** dcct 应用在盒子上的包名 / 入口 Ability（resource/data/dcct.hap pack.info 读取）。 */
export const DCCT_BUNDLE_NAME = 'com.example.myapplication';
export const DCCT_ABILITY_NAME = 'EntryAbility';

/**
 * 「不要搞错盒子 SN」防呆：盒子 SN 必须非空、且不能与任何被测设备 SN 相同。
 * 返回 { ok, reason }（reason 为中文提醒文案）。
 */
export function isTestBoxSnValid(boxSn, dutSns) {
  const list = parseSnsInput(boxSn);
  if (list.length === 0) {
    return { ok: false, reason: '没有填写测试盒子 SN——DCTS 必须先连接测试盒子，请在设置里填写或跳过 DCTS。' };
  }
  const duts = parseSnsInput(dutSns);
  const clash = list.find((sn) => duts.some((dut) => dut.toLowerCase() === sn.toLowerCase()));
  if (clash) {
    return { ok: false, reason: `测试盒子 SN（${clash}）与被测设备相同——盒子 SN 不是被测设备，请检查设置。` };
  }
  return { ok: true, reason: '' };
}

/** 从 ifconfig 输出里取 inet addr（如 `inet addr:192.168.101.11`）；读不到返回 ''。 */
export function parseIfconfigInet(text) {
  const match = String(text ?? '').match(/inet addr:\s*(\d{1,3}(?:\.\d{1,3}){3})/i)
    ?? String(text ?? '').match(/inet\s+(\d{1,3}(?:\.\d{1,3}){3})/i);
  return match ? match[1] : '';
}

/** /24 同网段判定（前三段一致）；任一 IP 非法则返回 false。 */
export function sameSubnet(a, b) {
  const parts = (ip) => String(ip ?? '').trim().split('.').map((item) => Number(item));
  const left = parts(a);
  const right = parts(b);
  if (left.length !== 4 || right.length !== 4) return false;
  if ([...left, ...right].some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return false;
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

/**
 * 在 uitest dumpLayout 的布局 JSON 文本里找任一标识符（被测设备 marketName/productModel 等）。
 * 容错解析：不做严格 JSON.parse，直接文本包含匹配（属性值/文本节点都能命中）；空输入返回 false。
 */
export function parseUiLayoutForIdentifiers(jsonText, identifiers) {
  const text = String(jsonText ?? '');
  if (!text) return false;
  const list = (Array.isArray(identifiers) ? identifiers : [identifiers])
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length >= 2);
  if (list.length === 0) return false;
  return list.some((item) => text.includes(item));
}

/**
 * 把若干 per-module result XML（根节点 `<testsuites name="<模块>">`）聚合成一份
 * summary_report.xml 文本。中断轮次没有 summary——用已完成模块的 result XML 合成。
 * 聚合口径：errors/disabled/failures/tests/ignored/unavailable 求和；
 * modules = 收到的模块 XML 数，runmodules = 其中 tests>0 的模块数。
 */
export function synthesizeSummaryReport(moduleXmls) {
  const list = (Array.isArray(moduleXmls) ? moduleXmls : []).map((item) => String(item ?? ''));
  const inners = [];
  const sums = { errors: 0, disabled: 0, failures: 0, tests: 0, ignored: 0, unavailable: 0 };
  let runModules = 0;
  for (const text of list) {
    const rootMatch = text.match(/<testsuites\b[^>]*>/);
    if (!rootMatch) continue;
    const closeIndex = text.lastIndexOf('</testsuites>');
    const inner = text.slice(rootMatch.index + rootMatch[0].length, closeIndex >= 0 ? closeIndex : undefined).trim();
    if (!inner) continue;
    const root = tagAttributes(rootMatch[0]);
    for (const key of Object.keys(sums)) {
      const value = Number(root[key]);
      if (Number.isFinite(value)) sums[key] += value;
    }
    if (Number(root.tests) > 0) runModules += 1;
    inners.push(inner);
  }
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const attrs = Object.entries(sums).map(([key, value]) => `${key}="${value}"`).join(' ');
  return [
    `<?xml version='1.0' encoding='UTF-8'?>`,
    `<testsuites name="summary_report" starttime="${stamp}" endtime="${stamp}" ${attrs} modules="${inners.length}" runmodules="${runModules}">`,
    ...inners,
    `</testsuites>`,
  ].join('\n');
}

function decodeXmlEntities(text) {
  return String(text ?? '')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlStampToMs(stamp) {
  const value = Date.parse(String(stamp ?? '').replace(' ', 'T'));
  return Number.isFinite(value) ? value : NaN;
}

/**
 * 从 per-module result XML（根节点 `<testsuites name="<模块>" … devices="CDATA[...]">`）
 * 合成 xdevice summary_report.html 所需的 `window.reportData` 对象。
 * 字段映射与真实 data.js 对齐：模块条目 / suites / cases / devices / summary 聚合。
 * summary.unavailable = 没跑到用例的模块数（tests=0），runmodules = 跑到用例的模块数。
 */
export function buildReportData(moduleXmls, options = {}) {
  const list = (Array.isArray(moduleXmls) ? moduleXmls : []).map((item) => String(item ?? ''));
  const modules = [];
  const totals = { tests: 0, passed: 0, failed: 0, blocked: 0, ignored: 0 };
  let unavailableModules = 0;
  let runModules = 0;
  let devices = [];
  let startMs = NaN;
  let endMs = NaN;
  const suitePattern = /<testsuite\b([^>]*?)(\/>|>([\s\S]*?)<\/testsuite>)/g;
  const casePattern = /<testcase\b([^>]*?)(\/>|>[\s\S]*?<\/testcase>)/g;
  for (const text of list) {
    const rootMatch = text.match(/<testsuites\b([^>]*)>/);
    if (!rootMatch) continue;
    const root = tagAttributes(rootMatch[1]);
    const name = String(root.name ?? '').trim();
    if (!name) continue;
    const tests = Number(root.tests) || 0;
    const failed = Number(root.failures) || 0;
    const blocked = Number(root.errors) || 0;
    const ignored = Number(root.ignored) || 0;
    const unavailable = Number(root.unavailable) || 0;
    const passed = Math.max(0, tests - failed - blocked - ignored);
    const start = xmlStampToMs(root.starttime);
    const end = xmlStampToMs(root.endtime);
    if (Number.isFinite(start) && (!Number.isFinite(startMs) || start < startMs)) startMs = start;
    if (Number.isFinite(end) && (!Number.isFinite(endMs) || end > endMs)) endMs = end;
    let moduleDevices = [];
    const cdata = decodeXmlEntities(root.devices).match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (cdata) { try { moduleDevices = JSON.parse(cdata[1]); } catch { moduleDevices = []; } }
    if (devices.length === 0 && moduleDevices.length > 0) devices = moduleDevices;
    const suites = [];
    for (const suiteMatch of text.matchAll(suitePattern)) {
      const attrs = tagAttributes(suiteMatch[1]);
      const body = suiteMatch[3] ?? '';
      const cases = [];
      for (const caseMatch of (body ?? '').matchAll(casePattern)) {
        const tc = tagAttributes(caseMatch[1]);
        const status = tc.result === 'true' ? 'Passed'
          : tc.result === 'false' ? 'Failed'
          : String(tc.status ?? '') === 'ignored' ? 'Ignored' : 'Blocked';
        cases.push([tc.name ?? '', tc.classname ?? '', status, Number(tc.time) || 0, decodeXmlEntities(tc.message ?? ''), tc.report ?? '']);
      }
      const sTests = Number(attrs.tests) || 0;
      const sFailed = Number(attrs.failures) || 0;
      const sBlocked = Number(attrs.errors) || 0;
      const sIgnored = Number(attrs.ignored) || 0;
      const sPassed = Math.max(0, sTests - sFailed - sBlocked - sIgnored);
      suites.push({
        name: attrs.name ?? '',
        report: attrs.report ?? '',
        time: Number(attrs.time) || 0,
        tests: sTests,
        passed: sPassed,
        failed: sFailed,
        blocked: sBlocked,
        ignored: sIgnored,
        passingrate: sTests > 0 ? `${((sPassed / sTests) * 100).toFixed(1)}%` : '0.0%',
        cases,
      });
    }
    const seconds = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : 0;
    modules.push({
      name,
      report: '',
      round: Number(root.round) || 1,
      test_type: root.test_type ?? '',
      test_start: root.starttime ?? '',
      test_end: root.endtime ?? '',
      time: Number(root.time) || 0,
      execute_time: `${seconds}s`,
      tests,
      passed,
      failed,
      blocked,
      ignored,
      unavailable,
      passingrate: tests > 0 ? `${((passed / tests) * 100).toFixed(1)}%` : '0.0%',
      error: decodeXmlEntities(root.message ?? ''),
      logs: {},
      devices: moduleDevices,
      suites,
    });
    totals.tests += tests;
    totals.passed += passed;
    totals.failed += failed;
    totals.blocked += blocked;
    totals.ignored += ignored;
    if (tests > 0) runModules += 1;
    else unavailableModules += 1;
  }
  const localStamp = (ms) => {
    const date = new Date(ms);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };
  const startTime = Number.isFinite(startMs) ? localStamp(startMs) : '';
  const endTime = Number.isFinite(endMs) ? localStamp(endMs) : '';
  const executeSeconds = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, Math.round((endMs - startMs) / 1000)) : 0;
  return {
    exec_info: {
      test_start: startTime,
      test_end: endTime,
      execute_time: `${executeSeconds}s`,
      test_type: String(options.testType ?? ''),
      host_info: String(options.hostInfo ?? ''),
      logs: options.logs ?? {},
    },
    summary: {
      modules: modules.length,
      repeat: 1,
      runmodules: runModules,
      tests: totals.tests,
      passed: totals.passed,
      failed: totals.failed,
      blocked: totals.blocked,
      ignored: totals.ignored,
      unavailable: unavailableModules,
    },
    devices,
    modules,
  };
}

/** summary.ini 文本（xdevice 同款字段）。 */
export function buildSummaryIni({ testType, deviceName, hostInfo, startTime, endTime, executionTime, logPath }) {
  return [
    '[default]',
    'Platform=OpenHarmony',
    `Test Type=${testType}`,
    `Device Name=${deviceName}`,
    `Host Info=${hostInfo}`,
    `Test Start/ End Time=${startTime}/ ${endTime}`,
    `Execution Time=${executionTime}`,
    'Device Type=Phone',
    logPath ? `Log Path=${logPath}` : '',
  ].filter(Boolean).join('\n') + '\n';
}

/** task_info.record 文本（JSON，字段与 xdevice 同款）。 */
export function buildTaskInfoRecord({ command, sessionId, reportPath, dataReports, unsuccessfulParams = {} }) {
  return `${JSON.stringify({ command, session_id: sessionId, report_path: reportPath, unsuccessful_params: unsuccessfulParams, data_reports: dataReports }, null, 2)}\n`;
}

/**
 * 从设备目录的申请资料 xlsx 读「是否带屏」（用户 2026-11-26 要求：按申请资料选测试集，不靠 hidumper 猜）。
 * 返回 'yes' | 'no' | ''（读不到/没填）。不同模板把值放在不同列，所以扫整行取第一个非空单元格；
 * 工作表优先「测评编号已填写」的那张，避免读到模板空表。
 */
export async function readScreenFromWorkbook(deviceDir) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const entries = await fs.readdir(deviceDir).catch(() => []);
  const file = entries.find((name) => /兼容性申请资料.*\.xlsx$/i.test(name) && !name.startsWith('~$'));
  if (!file) return { screen: '', source: '', note: '设备目录里没有 OpenHarmony兼容性申请资料.xlsx' };
  let ExcelJS;
  try {
    ExcelJS = (await import('exceljs')).default;
  } catch {
    return { screen: '', source: '', note: '未安装 exceljs，无法读取申请资料' };
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(deviceDir, file));
  const cellText = (cell) => {
    const value = cell?.value;
    if (value === null || value === undefined) return '';
    if (typeof value === 'object' && 'text' in value) return String(value.text ?? '').trim();
    if (typeof value === 'object' && 'result' in value) return String(value.result ?? '').trim();
    return String(value).trim();
  };
  // 「不带屏」里含「带屏」，必须先判否定再判肯定（2026-11-26 实测 CDO-RK3568 被误判成有屏）。
  const isNoValue = (text) => /不带屏|无屏|^否$/.test(text);
  const isYesValue = (text) => (/不带屏|无屏|^否$/.test(text) ? false : /带屏|^是$/.test(text));
  const sheets = [];
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
    sheets.push({ name: sheet.name, certified, screen });
  }
  const withScreen = sheets.filter((item) => item.screen);
  const hit = withScreen.find((item) => item.certified) ?? withScreen[0];
  if (!hit) return { screen: '', source: `${file}`, note: '申请资料里「是否带屏」为空' };
  return { screen: hit.screen, source: `${file}#${hit.name}`, note: '' };
}
