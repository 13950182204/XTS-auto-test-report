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
    if (!hasFailures && !allIgnored) continue;
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
      && Number.isFinite(total) && Number.isFinite(runModules) && runModules === total
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
 * 测试方案：串行顺序固定 ssts → hats → dcts(仅有屏) → acts。
 * - ssts / dcts **单机执行**（singleDevice：只取第一台 SN，不参与多机并行）；
 * - dcts 跑前要执行套件 resource/ 下的 `dcts_resource.bat` 安装测试工具（执行时按
 *   `<套件>_resource.bat` 通用探测，ssts 的 resource 只有工具 hap、无 bat）。
 */
export function suitePlan(screen) {
  const plan = [
    { suite: 'ssts', mode: 'task', singleDevice: true },
    { suite: 'hats', mode: 'list', minFile: 'hats-min.txt' },
  ];
  if (screen === 'yes') {
    plan.push({ suite: 'dcts', mode: 'list', minFile: 'dcts-min.txt', singleDevice: true });
  }
  plan.push({ suite: 'acts', mode: 'list', minFile: 'acts-min.txt' });
  return plan;
}

/** 套件目录名 → 归档目录名（report/SSTS/report-1 的对应路径，沿用现有大写约定）。 */
export function suiteArchiveName(suite) {
  return { ssts: 'SSTS', hats: 'HATS', dcts: 'DCTS', acts: 'ACTS' }[suite] || String(suite).toUpperCase();
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
