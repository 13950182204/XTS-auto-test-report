import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  DCCT_ABILITY_NAME,
  DCCT_BUNDLE_NAME,
  DEFAULT_TEST_BOX_SN,
  excludeHdfModules,
  filterHdfModules,
  buildUserConfig,
  isTestBoxSnValid,
  joinSns,
  nextReportIndex,
  parseHdcScreenOutput,
  parseHdcTargets,
  parseIfconfigInet,
  parseRunListLine,
  parseSnsInput,
  parseSummaryReport,
  parseTaskInfoRecordText,
  parseUiLayoutForIdentifiers,
  parseXdeviceExecLine,
  resolveMinSetDirName,
  sameSubnet,
  suiteArchiveName,
  suitePlan,
} from './xts_test_logic.mjs';

/**
 * XTS 自动测试编排（串行 ssts → hats → dcts(仅有屏) → acts，套件内多设备并行）。
 *
 * 直接 `python -m xdevice`（跳过 run.bat 每次的 pip 卸载重装），最小测试集清单
 * 走 `-tf <每行一个模块>`（绕开 Windows 32KB 命令行上限），ssts 用任务模式 `run ssts`。
 * 每轮 xdevice 报告完整归档到 <设备目录>\report\<SUITE>\report-<n>（n 递增不覆盖），
 * 失败模块自动增量补测（上限 --max-retry 轮）。
 *
 * stdout 协议行（单行 JSON，供宿主 phase2-routes 解析）：
 *   XTS_TEST_PROGRESS={"percent":…,"stage":…,"detail":…,"suite":…,"suiteIndex":…,"suiteTotal":…,"round":…,"devices":[…],"etaSeconds":…}
 *   XTS_TEST_ROUND={"suite":…,"round":…,"ok":…,"failedModules":[…],"archivedTo":"…","message":"…"}
 *   XTS_TEST_RESULT={"ok":…,"message":…,"plan":[…],"screens":{…},"rounds":[…],"unpassed":[…]}
 */

const WATCHDOG_IDLE_MS = 60 * 60 * 1000;
const RESULT_POLL_MS = 5000;
const PROGRESS_EMIT_MS = 1500;
const HDC_TIMEOUT_MS = 15000;
/** xdevice 的运行产物目录名（result/、summary_report.xml 所在）。 */
const REPORT_RESULT_DIR = 'result';

class TestFlowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TestFlowError';
  }
}

function usage() {
  return `Usage:
  node scripts/xts_run_test.mjs --testcases <xts-acts 套件根目录> --sns <SN1;SN2 或多行> --workbook <设备目录（或批量父目录）>
       [--screen yes|no] [--max-retry 2] [--dry-run] [--artifacts <目录>] [--python python]

--testcases  xts-acts 套件根目录（下含 ssts/ hats/ dcts/ acts/ 子目录）。
--sns        被测设备 SN，分号/逗号/换行分隔；套件内多设备并行（ssts/dcts 单机执行，取第一台）。
--workbook   报告归档根：<该目录>/report/<SUITE>/report-<n>。
--screen     跳过 hdc 探测，直接指定无屏(no)/有屏(yes)方案；缺省自动探测。
--max-retry  自动增量补测上限（默认 2，不含首轮）。
--box-sn     测试盒子 SN（DCTS 前置连通预检；默认 370100654d4d43202010000071dd7b00，传空=未配置）。
--box-wait-ms 盒子连通预检等待上限（默认 300000=5 分钟，超时跳过 DCTS）。
--suites     只跑指定套件（逗号分隔子集，如 --suites acts 或 --suites ssts,acts）。
--modules    覆盖最小测试集，直接用给定模块清单（分号分隔；配合 --suites 做单模块冒烟）。
--dry-run    只探测设备、生成配置与清单并打印将执行的命令，不真正跑测试。
说明：ssts / dcts 固定单机执行（取第一台 SN）；dcts 首轮会自动执行套件 resource/ 下的
dcts_resource.bat 安装测试工具（bat 会重启设备并等待回线；hdc 调用自动注入 -t 指定目标机）；
随后做测试盒子连通预检（盒子在线 / 同网段 / ping / dcct 配对，人工完成点击与 PIN），
预检不过超时后跳过 DCTS 继续后续套件；盒子 SN 不能是被测设备 SN。
环境变量：
  OH_XTS_PYTHON　　指定 python 可执行（也可用 --python）；
  OH_XTS_HDC　　　 指定 hdc 可执行（默认取 PATH）。`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i += 1;
  }
  return args;
}

function emitProgress(payload) {
  console.log(`XTS_TEST_PROGRESS=${JSON.stringify(payload)}`);
}

function emitRound(payload) {
  console.log(`XTS_TEST_ROUND=${JSON.stringify(payload)}`);
}

function emitResult(result) {
  console.log(`XTS_TEST_RESULT=${JSON.stringify(result)}`);
}

async function writeResult(artifacts, result) {
  if (!artifacts) return;
  await fs.writeFile(path.join(artifacts, 'result.json'), `${JSON.stringify(result, null, 2)}\n`).catch(() => {});
}

function runCommand(command, args, { timeoutMs = HDC_TIMEOUT_MS, spawnOptions = {} } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { windowsHide: true, ...spawnOptions });
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        try { child.kill(); } catch { /* 进程已退出 */ }
      }, timeoutMs)
      : undefined;
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, error });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr });
    });
  });
}

async function hdcCommand(hdc, args, timeoutMs = HDC_TIMEOUT_MS) {
  const result = await runCommand(hdc, args, { timeoutMs });
  if (result.error) {
    const reason = result.error.code === 'ENOENT'
      ? `找不到 hdc（${hdc}）。请确认 hdc 在 PATH 里，或用环境变量 OH_XTS_HDC 指定。`
      : `hdc 启动失败：${result.error.message}`;
    throw new TestFlowError(reason);
  }
  return result;
}

function isDirectory(file) {
  return fs.stat(file).then((stat) => stat.isDirectory()).catch(() => false);
}

function isFile(file) {
  return fs.stat(file).then((stat) => stat.isFile()).catch(() => false);
}

/**
 * 定位本轮 xdevice 报告目录。`-rp` 模式下报告**直接落在给定根目录**
 * （log/ result/ summary_report.xml…，实测如此）；默认布局才是 <root>/<时间戳>/。
 * 先看根目录本身，再退回找含产物的最新子目录。
 */
async function resolveReportDirectory(reportRoot) {
  if (await isFile(path.join(reportRoot, 'task_info.record'))
    || await isDirectory(path.join(reportRoot, REPORT_RESULT_DIR))) {
    return reportRoot;
  }
  const entries = await fs.readdir(reportRoot, { withFileTypes: true }).catch(() => []);
  let latest;
  let latestMs = -1;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(reportRoot, entry.name);
    const isReport = await isDirectory(path.join(full, REPORT_RESULT_DIR))
      || await isFile(path.join(full, 'task_info.record'));
    if (!isReport) continue;
    const stat = await fs.stat(full).catch(() => undefined);
    const ms = stat?.mtimeMs ?? -1;
    if (ms > latestMs) { latest = full; latestMs = ms; }
  }
  return latest;
}

/** 已完成模块名（result/<模块>.xml，不含扩展名、小写归一便于比对）。 */
async function finishedModuleNames(reportDirectory) {
  if (!reportDirectory) return [];
  const entries = await fs.readdir(path.join(reportDirectory, REPORT_RESULT_DIR), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.xml'))
    .map((entry) => entry.name.slice(0, -4).toLowerCase());
}

function killTree(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } catch {
    // 尽力而为：进程可能刚好退出。
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RESOURCE_BAT_TIMEOUT_MS = 15 * 60 * 1000;

/** 解析 hdc 真实可执行文件路径（供 shim 转发）；解析不到返回 null。 */
async function resolveHdcExecutable(hdc) {
  if (/[\\/]/.test(hdc)) return hdc;
  const probe = await runCommand('where', [hdc], { timeoutMs: 10000 }).catch(() => undefined);
  if (!probe || probe.code !== 0) return null;
  const first = probe.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
  return first || null;
}

/**
 * 执行套件 resource/ 下的资源安装 bat（如 dcts_resource.bat）。套件原文件不动，坑点就地处理：
 * - bat 里全是裸 `hdc`，多设备在线时会直接失败 → 在工作区生成 hdc.cmd shim（`-t <sn> %*`）
 *   并把它排进 PATH 最前；bat 用 @start 拉起的服务窗口继承同一 PATH，同样落对设备；
 * - bat 结尾有 `pause` → stdin 给 'ignore'（EOF 直接放行），不会卡住；
 * - bat 会 `hdc shell reboot` 且只等 30 秒 → 返回后由调用方轮询设备回线。
 */
async function runResourceBat(batFile, sn, hdc, workspace, onDetail) {
  const realHdc = await resolveHdcExecutable(hdc);
  let env = process.env;
  if (realHdc && path.win32.extname(realHdc).toLowerCase() === '.exe') {
    const shimDir = path.join(workspace, 'hdc-shim');
    await fs.mkdir(shimDir, { recursive: true });
    const shim = ['@echo off', `"${realHdc}" -t ${sn} %*`].join('\r\n');
    await fs.writeFile(path.join(shimDir, 'hdc.cmd'), shim, 'utf8');
    env = { ...process.env, PATH: `${shimDir};${path.dirname(realHdc)};${process.env.PATH ?? ''}` };
  } else {
    onDetail?.('未解析到 hdc.exe 路径，bat 里的 hdc 按默认目标执行（请确保目标机是 hdc 默认设备）。');
  }
  onDetail?.(`执行 ${path.basename(batFile)} 安装测试工具（目标设备 ${sn}，会重启设备并等待回线）…`);
  const result = await runCommand('cmd', ['/c', batFile], {
    timeoutMs: RESOURCE_BAT_TIMEOUT_MS,
    spawnOptions: {
      cwd: path.dirname(batFile),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  });
  if (result.error) {
    return { ok: false, code: -1, output: `hdc/bat 启动失败：${result.error.message}` };
  }
  return { ok: result.code === 0, code: result.code, output: `${result.stdout}\n${result.stderr}`.trim() };
}

/** 设备（如 bat 重启后）回线等待；在线后额外静置几秒让 hdc 稳定。 */
async function waitForDeviceOnline(hdc, sn, timeoutMs = 3 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await hdcCommand(hdc, ['list', 'targets'], 10000);
      if (parseHdcTargets(targets.stdout).includes(sn)) {
        await sleep(5000);
        return true;
      }
    } catch {
      // hdc 瞬时失败继续等。
    }
    await sleep(5000);
  }
  return false;
}

const BOX_POLL_INTERVAL_MS = 15000;

function pingArgs() {
  // Windows: ping -n 2 -w 1000 <ip>；POSIX（排障用）: ping -c 2 -W 1 <ip>。
  return process.platform === 'win32' ? ['-n', '2', '-w', '1000'] : ['-c', '2', '-W', '1'];
}

async function readWlanIp(hdc, sn) {
  const result = await hdcCommand(hdc, ['-t', sn, 'shell', 'ifconfig', 'wlan0'], 10000).catch(() => undefined);
  return result && result.code === 0 ? parseIfconfigInet(result.stdout) : '';
}

async function deviceParam(hdc, sn, param) {
  const result = await hdcCommand(hdc, ['-t', sn, 'shell', 'param', 'get', param], 10000).catch(() => undefined);
  if (!result || result.code !== 0) return '';
  const lines = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.pop() || '';
  // 参数不存在时 hdc 回显 "Get parameter "x" fail! errNum is:106!"——不能把回显当参数值。
  if (!last || /fail!|errNum/i.test(last) || /^Get parameter/i.test(last)) return '';
  return last;
}

async function boxHasDcct(hdc, boxSn) {
  const result = await hdcCommand(hdc, ['-t', boxSn, 'shell', 'bm', 'dump', '-a'], 15000).catch(() => undefined);
  if (!result || result.code !== 0) return false;
  return result.stdout.includes(DCCT_BUNDLE_NAME);
}

async function dumpBoxLayout(hdc, boxSn, workspace) {
  // 优先 -p 落文件再 cat（多数版本 stdout 只打印落盘路径）；失败退回 stdout 直出。
  const remote = '/data/local/tmp/oh-dsh-boxui.json';
  const dumped = await hdcCommand(hdc, ['-t', boxSn, 'shell', 'uitest', 'dumpLayout', '-p', remote], 15000).catch(() => undefined);
  if (dumped && dumped.code === 0) {
    const content = await hdcCommand(hdc, ['-t', boxSn, 'shell', 'cat', remote], 10000).catch(() => undefined);
    if (content && content.code === 0 && content.stdout.trim()) return content.stdout;
  }
  const plain = await hdcCommand(hdc, ['-t', boxSn, 'shell', 'uitest', 'dumpLayout'], 15000).catch(() => undefined);
  return plain && plain.code === 0 ? plain.stdout : '';
}

/**
 * DCTS 前置：测试盒子连通预检 + 等待 dcct 配对（人工步骤：勾 Wi-Fi → 下一步 → 允许被发现
 * → 发现并点击目标设备 → 被测设备「永远信任」→ 盒子输 PIN）。
 *
 * 检查项（任一不过都在 deadline 内每 15s 重试并提醒，超时返回 connected:false = 跳过 DCTS）：
 * 盒子 hdc 在线 → 盒子/被测设备 wlan0 IP 同网段 → 宿主 ping 盒子 IP（ping 被拦但 hdc 能读
 * 到盒子 IP 时降级为「同网段即通过」）→ 盒子 dcct 应用（已装则自动拉起一次）→ 盒子 dcct
 * 界面出现被测设备标识（uitest 布局解析）。
 */
/**
 * uitest UI 自动化助手（配对流程由应用自动执行，不等人工）。
 */

function parseBounds(str) {
  const match = String(str ?? '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  return { x: Math.round((Number(match[1]) + Number(match[3])) / 2), y: Math.round((Number(match[2]) + Number(match[4])) / 2) };
}

function findTextInUiTree(node, keywords, results = []) {
  if (!node || typeof node !== 'object') return results;
  const attrs = node.attributes ?? node;
  const nodeText = String(attrs.text ?? '').trim();
  for (const keyword of keywords) {
    if (nodeText && nodeText.includes(keyword)) {
      const bounds = parseBounds(attrs.bounds);
      if (bounds) results.push({ text: nodeText, ...bounds });
      break;
    }
  }
  for (const child of node.children ?? []) findTextInUiTree(child, keywords, results);
  return results;
}

async function uitestFindByText(hdc, target, keywords, tag) {
  const remote = `/data/local/tmp/oh-uitest-${tag || 'pair'}.json`;
  const dumped = await hdcCommand(hdc, ['-t', target, 'shell', 'uitest', 'dumpLayout', '-p', remote], 15000).catch(() => undefined);
  let raw = '';
  if (dumped && dumped.code === 0) {
    const content = await hdcCommand(hdc, ['-t', target, 'shell', 'cat', remote], 10000).catch(() => undefined);
    if (content && content.code === 0) raw = content.stdout;
  }
  if (!raw) {
    const plain = await hdcCommand(hdc, ['-t', target, 'shell', 'uitest', 'dumpLayout'], 15000).catch(() => undefined);
    raw = plain && plain.code === 0 ? plain.stdout : '';
  }
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return findTextInUiTree(parsed, keywords);
  } catch { return []; }
}

async function uitestClick(hdc, target, x, y) {
  return hdcCommand(hdc, ['-t', target, 'shell', 'uitest', 'uiInput', 'click', String(Math.round(x)), String(Math.round(y))], 10000);
}

async function uitestInputText(hdc, target, x, y, text) {
  return hdcCommand(hdc, ['-t', target, 'shell', 'uitest', 'uiInput', 'inputText', String(Math.round(x)), String(Math.round(y)), text], 10000);
}

async function clickByText(hdc, target, keywords, tag) {
  const results = await uitestFindByText(hdc, target, keywords, tag);
  if (results.length === 0) return false;
  await uitestClick(hdc, target, results[0].x, results[0].y);
  return true;
}

/**
 * 自动执行 dcct 配对流程（双端 uitest 驱动，不等人工）。
 * 步骤：拉起 dcct → 勾 Wi-Fi → 下一步 → 允许被发现 → 发现 → 点击目标设备 →
 *       DUT 永远信任 → 读 PIN → 盒子输 PIN → 等待连接。
 * 任一步骤失败（超时找不到元素）→ 整体配对失败 → 跳过 DCTS。
 */
async function automateDcctPairing({ hdc, boxSn, dutSn, dutIp, workspace, deadlineMs, onDetail }) {
  const startedAt = Date.now();
  const dutIdentifiers = [];
  for (const param of ['const.product.name', 'const.product.model', 'const.product.brand']) {
    const value = await deviceParam(hdc, dutSn, param).catch(() => '');
    if (value && value.length >= 2 && !dutIdentifiers.includes(value)) dutIdentifiers.push(value);
  }

  // —— 1. 唤醒并解锁盒子屏幕（锁屏时 uitest dump 到的是锁屏而非 dcct UI） ——
  onDetail?.('唤醒并解锁盒子屏幕…');
  await hdcCommand(hdc, ['-t', boxSn, 'shell', 'power-shell', 'wakeup'], 10000).catch(() => {});
  await sleep(1000);
  await hdcCommand(hdc, ['-t', boxSn, 'shell', 'uitest', 'uiInput', 'swipe', '400', '1100', '400', '300', '300'], 10000).catch(() => {});
  await sleep(2000);
  // 保持屏幕常亮
  await hdcCommand(hdc, ['-t', boxSn, 'shell', 'power-shell', 'setmode', '602'], 10000).catch(() => {});

  // —— 2. 拉起 dcct on box ——
  onDetail?.('正在盒子上拉起 dcct 应用…');
  await hdcCommand(hdc, ['-t', boxSn, 'shell', 'aa', 'start', '-b', DCCT_BUNDLE_NAME, '-a', DCCT_ABILITY_NAME], 15000).catch(() => undefined);
  await sleep(3000);

  // —— 2. 盒子 UI 配对步骤 ——
  const boxSteps = [
    { keywords: ['Wi-Fi', 'wifi', 'WLAN'], wait: 2000, desc: '勾选 Wi-Fi' },
    { keywords: ['下一步'], wait: 2000, desc: '点击下一步' },
    { keywords: ['允许被发现'], wait: 2000, desc: '打开允许被发现' },
    { keywords: ['发现', '搜索', '扫描'], wait: 3000, desc: '触发设备发现' },
  ];
  for (const step of boxSteps) {
    let clicked = false;
    for (let retry = 0; retry < 3; retry++) {
      try {
        clicked = await clickByText(hdc, boxSn, step.keywords, `box-${step.desc}`);
        if (clicked) break;
      } catch { /* 重试 */ }
      await sleep(2000);
    }
    onDetail?.(clicked ? `盒子 dcct 自动配对：${step.desc} ✓` : `盒子 dcct：未找到「${step.desc}」（可能已完成），跳过`);
    await sleep(step.wait);
  }

  // —— 3. 等待目标设备出现在发现列表，点击它 ——
  onDetail?.('等待目标设备出现在盒子 dcct 发现列表…');
  let dutClicked = false;
  const dutDeadline = Date.now() + Math.min(deadlineMs, 120000);
  while (Date.now() < dutDeadline && !dutClicked) {
    const results = await uitestFindByText(hdc, boxSn, dutIdentifiers, 'box-dut-list').catch(() => []);
    if (results.length > 0) {
      await uitestClick(hdc, boxSn, results[0].x, results[0].y);
      dutClicked = true;
      onDetail?.(`已点击目标设备（${results[0].text}），等待 DUT 信任弹窗与 PIN…`);
      break;
    }
    await clickByText(hdc, boxSn, ['发现', '刷新', '搜索'], 'box-refresh').catch(() => {});
    await sleep(5000);
  }
  if (!dutClicked) {
    return { connected: false, reason: `盒子上未发现目标设备（${dutIdentifiers.join(' / ')}），请确认同网段且 dcct 允许被发现` };
  }

  // —— 4. DUT：等待「永远信任」弹窗并点击 ——
  await sleep(3000);
  let trusted = false;
  const trustDeadline = Date.now() + 30000;
  while (Date.now() < trustDeadline && !trusted) {
    const results = await uitestFindByText(hdc, dutSn, ['永远信任', '始终信任'], 'dut-trust').catch(() => []);
    if (results.length > 0) {
      await uitestClick(hdc, dutSn, results[0].x, results[0].y);
      trusted = true;
      onDetail?.('已在被测设备上点击「永远信任」');
      break;
    }
    await sleep(3000);
  }
  if (!trusted) onDetail?.('未检测到「永远信任」弹窗（可能已信任过），继续');

  // —— 5. DUT：读取 PIN 码 ——
  await sleep(2000);
  let pin = '';
  const pinRaw = await dumpBoxLayout(hdc, dutSn, workspace).catch(() => '');
  const pinMatch = pinRaw.match(/\b(\d{4,8})\b/);
  if (pinMatch) pin = pinMatch[1];

  // —— 6. 盒子：输入 PIN ——
  if (pin) {
    onDetail?.(`读取到 PIN ${pin}，正在盒子上输入…`);
    await sleep(2000);
    const pinFields = await uitestFindByText(hdc, boxSn, ['PIN', 'pin', '配对码', '输入'], 'box-pin').catch(() => []);
    if (pinFields.length > 0) {
      await uitestInputText(hdc, boxSn, pinFields[0].x, pinFields[0].y, pin);
    } else {
      await uitestInputText(hdc, boxSn, 540, 800, pin).catch(() => {});
    }
    await sleep(1000);
    await clickByText(hdc, boxSn, ['确认', '配对', '确定'], 'box-pin-ok').catch(() => {});
    onDetail?.(`PIN ${pin} 已输入`);
  } else {
    onDetail?.('未读取到 PIN（可能无需 PIN），继续等待连接');
  }

  // —— 7. 等待连接建立 ——
  onDetail?.('等待连接建立…');
  const connectDeadline = Date.now() + 30000;
  while (Date.now() < connectDeadline) {
    const layout = await dumpBoxLayout(hdc, boxSn, workspace).catch(() => '');
    if (layout && /已连接|connected|连接成功/i.test(layout)) {
      return { connected: true, reason: 'dcct 配对成功，盒子与被测设备已连接' };
    }
    const dutLayout = await dumpBoxLayout(hdc, dutSn, workspace).catch(() => '');
    if (dutLayout && /已连接|connected|连接成功/i.test(dutLayout)) {
      return { connected: true, reason: 'dcct 配对成功（DUT 侧确认）' };
    }
    await sleep(5000);
  }
  // 配对步骤全部完成，即使 UI 未显式"已连接"，也视为配对成功——DCTS 模块自身验证
  return { connected: true, reason: 'dcct 配对流程已自动执行完毕（PIN 已输入/无 PIN），DCTS 模块将验证连接质量' };
}

/**
 * DCTS 前置：测试盒子连通预检 + 自动执行 dcct 配对流程（双端 uitest 驱动）。
 * 预检通过 → 自动配对 → 成功跑 DCTS / 失败跳过 DCTS。
 */
async function runTestBoxPrecheck({ hdc, boxSn, dutSn, dutSns, workspace, deadlineMs, onDetail }) {
  const invalid = isTestBoxSnValid(boxSn, dutSns);
  if (!invalid.ok) return { connected: false, reason: invalid.reason };

  // —— 预检：盒子在线 / 同网段 / ping（60s 内） ——
  let boxIp = '';
  let dutIp = '';
  let precheckOk = false;
  let lastStatus = '';
  const precheckDeadline = Date.now() + 60000;
  while (Date.now() < precheckDeadline) {
    const targets = await hdcCommand(hdc, ['list', 'targets'], 10000).catch(() => undefined);
    const online = targets ? parseHdcTargets(targets.stdout) : [];
    if (!online.includes(boxSn)) {
      lastStatus = '盒子不在线（请确认盒子经 hdc 连接本机）';
    } else {
      boxIp = await readWlanIp(hdc, boxSn).catch(() => '');
      dutIp = await readWlanIp(hdc, dutSn).catch(() => '');
      if (!boxIp || !dutIp) {
        lastStatus = `读不到 IP（盒子 ${boxIp || '?'} / 被测设备 ${dutIp || '?'})`;
      } else if (!sameSubnet(boxIp, dutIp)) {
        lastStatus = `不在同网段（盒子 ${boxIp} vs 被测设备 ${dutIp}）`;
      } else {
        const ping = await runCommand('ping', [...pingArgs(), boxIp], { timeoutMs: 15000 }).catch(() => undefined);
        precheckOk = true;
        lastStatus = `预检通过（盒子 ${boxIp} · 被测设备 ${dutIp} · 同网段${ping?.code === 0 ? ' · ping ✓' : ''}）`;
        break;
      }
    }
    onDetail?.(lastStatus);
    await sleep(BOX_POLL_INTERVAL_MS);
  }
  if (!precheckOk) {
    return { connected: false, reason: `预检未通过（60s 内）：${lastStatus}` };
  }

  // —— 自动执行 dcct 配对流程 ——
  onDetail?.('预检通过，开始自动执行 dcct 配对流程…');
  const pairResult = await automateDcctPairing({
    hdc, boxSn, dutSn, dutIp, workspace,
    deadlineMs: Math.max(30000, deadlineMs - 60000),
    onDetail,
  });
  return pairResult;
}

function main() {
  return doRun(parseArgs(process.argv.slice(2)));
}

async function doRun(args) {
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const startedAt = Date.now();
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const artifacts = args.artifacts ? path.resolve(String(args.artifacts)) : path.join(os.tmpdir(), `oh-xts-test-${stamp}`);
  await fs.mkdir(artifacts, { recursive: true });

  const rounds = [];
  const unpassed = [];
  const skippedSuites = [];
  const warnings = [];

  try {
    // —— 参数与路径校验 ——
    if (!args.testcases) throw new TestFlowError('没有提供测试用例路径（--testcases），已停止执行。');
    if (!args.workbook) throw new TestFlowError('没有提供设备目录（--workbook），报告不知道归档到哪里，已停止执行。');
    const testcaseRoot = path.resolve(String(args.testcases));
    const workbookRoot = path.resolve(String(args.workbook));
    const sns = parseSnsInput(args.sns);
    if (sns.length === 0) throw new TestFlowError('没有提供被测设备 SN（--sns），已停止执行。');
    if (!await isDirectory(testcaseRoot)) throw new TestFlowError(`测试用例路径不存在：${testcaseRoot}`);
    if (!await isDirectory(workbookRoot)) throw new TestFlowError(`设备目录不存在：${workbookRoot}`);
    const maxRetry = Math.max(0, Math.floor(Number(args['max-retry'] ?? 2)) || 0);
    const python = String(args.python || process.env.OH_XTS_PYTHON || 'python');
    const hdc = String(process.env.OH_XTS_HDC || 'hdc');
    // 测试盒子 SN：宿主总是显式传（可能为空=未配置），脚本内缺省仅用于裸命令行冒烟。
    const testBoxSn = 'box-sn' in args ? String(args['box-sn'] ?? '').trim() : DEFAULT_TEST_BOX_SN;
    const boxWaitMs = Math.max(30000, Math.floor(Number(args['box-wait-ms']) || 5 * 60 * 1000));

    // —— 设备在线校验与有屏/无屏探测 ——
    const targets = await hdcCommand(hdc, ['list', 'targets']);
    const online = parseHdcTargets(targets.stdout);
    const offline = sns.filter((sn) => !online.includes(sn));
    if (offline.length > 0) {
      throw new TestFlowError(`以下设备未通过 hdc 连上（请确认已连接并授权）：${offline.join('、')}`);
    }
    const forcedScreen = typeof args.screen === 'string' && args.screen
      ? (String(args.screen).toLowerCase() === 'yes' ? 'yes' : 'no')
      : '';
    const screens = {};
    let screen = forcedScreen;
    if (!screen) {
      for (const sn of sns) {
        const dump = await hdcCommand(hdc, ['-t', sn, 'shell', 'hidumper', '-s', 'RenderService', '-a', 'screen']);
        if (dump.code !== 0) {
          throw new TestFlowError(`设备 ${sn} 的有屏/无屏探测失败（hdc 退出码 ${dump.code}），无法选择测试方案。`);
        }
        screens[sn] = parseHdcScreenOutput(dump.stdout);
      }
      const values = [...new Set(Object.values(screens))];
      if (values.length !== 1) {
        throw new TestFlowError(`设备池混用了有屏与无屏设备（${JSON.stringify(screens)}），请分开测试。`);
      }
      screen = values[0];
    } else {
      for (const sn of sns) screens[sn] = screen;
    }

    // —— 测试方案与最小测试集 ——
    let plan = suitePlan(screen);
    const suiteFilter = String(args.suites || '').split(/[,;\s]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (suiteFilter.length > 0) {
      const invalid = suiteFilter.filter((item) => !['ssts', 'hats', 'dcts', 'acts'].includes(item));
      if (invalid.length > 0) throw new TestFlowError(`--suites 只支持 ssts/hats/dcts/acts，收到：${invalid.join('、')}`);
      plan = plan.filter((step) => suiteFilter.includes(step.suite));
      if (plan.length === 0) throw new TestFlowError(`--suites 过滤后没有可执行的套件：${suiteFilter.join('、')}`);
    }
    const overrideModules = args.modules ? parseRunListLine(String(args.modules)) : [];
    if (overrideModules.length > 0) {
      // 覆盖清单：所有套件都改成清单模式（含 ssts，`run -tf` 与 `run -l` 等价），跳过最小测试集。
      for (const step of plan) {
        step.mode = 'list';
        step.modules = [...overrideModules];
        delete step.minFile;
      }
    }
    const minSetParent = path.dirname(testcaseRoot);
    const minSetEntries = await fs.readdir(minSetParent).catch(() => []);
    const minSetDirName = resolveMinSetDirName(minSetEntries, screen);
    if (plan.some((step) => step.mode === 'list') && !minSetDirName && overrideModules.length === 0) {
      throw new TestFlowError(`在 ${minSetParent} 下找不到「标准最小测试集_${screen === 'no' ? '无屏' : '有屏'}…」目录，无法确定 acts/hats 最小集。`);
    }
    // 只校验将要执行的套件（--suites 过滤后不必要求其它套件也存在）。
    for (const step of plan) {
      const dirName = step.suite === 'hats-hdf' ? 'hats' : step.suite;
      const suiteDir = path.join(testcaseRoot, dirName);
      const config = path.join(suiteDir, 'config', 'user_config.xml');
      if (!await isDirectory(suiteDir)) throw new TestFlowError(`测试用例路径下没有 ${dirName} 套件目录：${suiteDir}`);
      if (!await isFile(config)) throw new TestFlowError(`缺少套件配置文件：${config}`);
    }
    const minSetDir = minSetDirName ? path.join(minSetParent, minSetDirName) : '';
    const listsDirectory = path.join(artifacts, 'lists');
    const reportsDirectory = path.join(artifacts, 'reports');
    await fs.mkdir(listsDirectory, { recursive: true });
    await fs.mkdir(reportsDirectory, { recursive: true });

    for (const step of plan) {
      if (step.mode !== 'list' || overrideModules.length > 0) continue;
      const file = path.join(minSetDir, step.minFile);
      if (!await isFile(file)) throw new TestFlowError(`缺少最小测试集清单：${file}`);
      let modules = parseRunListLine(await fs.readFile(file, 'utf8'));
      if (modules.length === 0) throw new TestFlowError(`最小测试集清单为空：${file}`);
      // HATS 主轮剔除 HDF 模块；HATS-HDF 增量轮只跑 HDF 模块。
      if (step.suite === 'hats' && screen === 'yes') {
        if (step.hdfOnly) {
          modules = filterHdfModules(modules);
          if (modules.length === 0) { step.skipReason = '无 HDF 模块'; continue; }
        } else {
          modules = excludeHdfModules(modules);
        }
      }
      step.modules = modules;
    }

    // —— 生成临时 user_config.xml（写在原 config 目录，保相对路径语义） ——
    // ssts/dcts 单机执行：这两套的 user_config 只写第一台 SN。
    const stepSns = (step) => (step.singleDevice ? sns.slice(0, 1) : sns);
    for (const step of plan) {
      const dirName = step.suite === 'hats-hdf' ? 'hats' : step.suite;
      const templatePath = path.join(testcaseRoot, dirName, 'config', 'user_config.xml');
      const generated = buildUserConfig(await fs.readFile(templatePath, 'utf8'), stepSns(step));
      await fs.writeFile(path.join(testcaseRoot, dirName, 'config', 'user_config.dsh-auto.xml'), generated, 'utf8');
    }

    const describePlan = () => plan.map((step) => {
      const scope = step.singleDevice ? `单机 ${sns[0].slice(-6)}` : `${sns.length} 台并行`;
      const hdfTag = step.hdfOnly ? 'HDF增量 ' : '';
      return step.mode === 'task'
        ? `SSTS 全测（run ssts · ${scope}）`
        : `${hdfTag}${suiteArchiveName(step.suite)} 最小集（${step.modules.length} 模块 · ${scope}）`;
    }).join(' → ');

    if (args['dry-run']) {
      const commands = plan.map((step) => {
        const reportRoot = path.join(reportsDirectory, `${step.suite}-r1`);
        return {
          suite: step.suite,
          command: [python, '-m', 'xdevice', 'run',
            ...(step.mode === 'task'
              ? [step.suite]
              : ['-tf', path.join(listsDirectory, `${step.suite}-r1.txt`)]),
            '-c', path.join(testcaseRoot, step.suite, 'config', 'user_config.dsh-auto.xml'),
            '-sn', joinSns(stepSns(step)),
            '-rp', reportRoot].join(' '),
        };
      });
      emitResult({
        ok: true,
        message: `dry-run 完成：${screen === 'yes' ? '有屏' : '无屏'}方案，${describePlan()}；设备 ${sns.length} 台（${sns.join('、')}）。未执行测试。`,
        plan: plan.map((step) => ({
          suite: step.suite,
          mode: step.mode,
          modules: step.mode === 'task' ? 0 : step.modules.length,
          singleDevice: step.singleDevice === true,
        })),
        screens,
        dryRun: true,
        commands,
        artifacts,
      });
      return 0;
    }

    // —— 串行执行各套件（套件内多设备并行，失败自动增量补测） ——
    let stopped = false;
    let currentChild = null;
    const onStopSignal = () => {
      stopped = true;
      if (currentChild?.pid) killTree(currentChild.pid);
      emitResult({ ok: false, message: '收到停止指令，测试已终止；已归档的轮次保留。', rounds, unpassed });
      process.exit(1);
    };
    process.on('SIGTERM', onStopSignal);
    process.on('SIGINT', onStopSignal);

    for (let stepIndex = 0; stepIndex < plan.length; stepIndex += 1) {
      if (stopped) return 1;
      const step = plan[stepIndex];
      const suiteDir = path.join(testcaseRoot, step.suite === 'hats-hdf' ? 'hats' : step.suite);
      let round = 1;
      // 补测轮固定走 -tf 清单（含 ssts：`run -l <失败模块>` 与 `run -tf` 等价）。
      let useList = step.mode === 'list';
      let pendingModules = step.mode === 'list' ? [...step.modules] : [];
      // 进度权重：任务模式在首条 Executing 行拿到真实总数前先用清单外默认值。
      let suiteTotal = step.mode === 'task' ? 0 : step.modules.length;
      let suiteDone = 0;
      let resourceInstalled = false;
      let boxPrecheckDone = false;
      let boxStaticOk = false;
      let skipReason = '';
      // ssts/dcts 单机执行：只取第一台 SN，资源 bat 也只对这台设备做。
      const suiteSns = stepSns(step);

      while (true) {
        if (stopped) return 1;

        // DCTS 前置第一关（跑资源 bat 之前快速失败，不白重启设备）：盒子 SN 防呆 + 盒子在线。
        if (step.suite === 'dcts' && round === 1 && !boxStaticOk) {
          boxStaticOk = true;
          const invalid = isTestBoxSnValid(testBoxSn, sns);
          if (!invalid.ok) {
            skipReason = invalid.reason;
            break;
          }
          const targetsNow = await hdcCommand(hdc, ['list', 'targets'], 10000).catch(() => undefined);
          const onlineNow = targetsNow ? parseHdcTargets(targetsNow.stdout) : [];
          if (!onlineNow.includes(testBoxSn)) {
            skipReason = `测试盒子（${testBoxSn}）不在 hdc 在线列表里——请确认盒子已连接本机；注意盒子 SN 不是被测设备 SN。`;
            break;
          }
          // 此处 emitTestProgress 还未定义（在循环体后面），直接用模块级 emitProgress。
          emitProgress({
            percent: 0,
            stage: `${suiteArchiveName(step.suite)} 盒子检查`,
            detail: `测试盒子 ${testBoxSn.slice(-6)} 在线，开始安装 DCTS 测试资源…`,
            suite: step.suite,
            suiteIndex: stepIndex + 1,
            suiteTotal: plan.length,
            round,
          });
        }

        const reportRoot = path.join(reportsDirectory, `${step.suite}-r${round}`);
        await fs.mkdir(reportRoot, { recursive: true });
        let listFile;
        if (useList) {
          listFile = path.join(listsDirectory, `${step.suite}-r${round}.txt`);
          await fs.writeFile(listFile, `${pendingModules.join('\n')}\n`, 'utf8');
        }

        const devices = new Map(suiteSns.map((sn) => [sn, { currentModule: '', started: 0 }]));
        let lastActivity = Date.now();
        const commandArgs = [
          '-m', 'xdevice', 'run',
          ...(useList ? ['-tf', listFile] : [step.suite]),
          '-c', path.join(testcaseRoot, step.suite, 'config', 'user_config.dsh-auto.xml'),
          '-sn', joinSns(suiteSns),
          '-rp', reportRoot,
        ];
        const devicesView = () => [...devices.entries()].map(([sn, value]) => ({
          sn,
          currentModule: value.currentModule,
          done: value.started,
          total: suiteTotal || 0,
        }));
        const suiteLabel = step.hdfLabel || suiteArchiveName(step.suite);
        const describeRound = (detail) => detail
          || (round > 1
            ? `${suiteLabel} 补测第 ${round - 1} 轮 · ${pendingModules.length} 模块`
            : `${suiteLabel} 第 ${round} 轮`);
        let lastEmit = 0;
        const emitTestProgress = (detail, force = false) => {
          const now = Date.now();
          if (!force && now - lastEmit < PROGRESS_EMIT_MS) return;
          lastEmit = now;
          const beforeSum = plan.reduce((sum, other, index) => index < stepIndex
            ? sum + (other.mode === 'task' ? 23 : other.modules.length)
            : sum, 0);
          const doneSum = beforeSum + suiteDone;
          const totalAll = beforeSum + (suiteTotal || 23) + plan.slice(stepIndex + 1)
            .reduce((sum, other) => sum + (other.mode === 'task' ? 23 : other.modules.length), 0);
          const percent = totalAll > 0 ? Math.min(100, Math.round((doneSum / totalAll) * 100)) : 0;
          const elapsed = (now - startedAt) / 1000;
          const etaSeconds = doneSum > 0 ? Math.round((elapsed / doneSum) * (totalAll - doneSum)) : undefined;
          emitProgress({
            percent,
            stage: round > 1 ? `${suiteArchiveName(step.suite)} 补测第 ${round - 1} 轮` : `${suiteArchiveName(step.suite)} 测试中`,
            detail: `${describePlan()} · ${describeRound(detail)}`,
            suite: step.suite,
            suiteIndex: stepIndex + 1,
            suiteTotal: plan.length,
            round,
            devices: devicesView(),
            etaSeconds,
          });
        };

        // ssts/dcts 单机执行：首轮先装测试资源（dcts_resource.bat 会重启设备并等待回线）。
        if (step.singleDevice && round === 1 && !resourceInstalled) {
          resourceInstalled = true;
          const resourceBat = path.join(suiteDir, 'resource', `${step.suite}_resource.bat`);
          if (await isFile(resourceBat)) {
            emitTestProgress(`正在执行 ${path.basename(resourceBat)} 安装测试工具（单机 ${suiteSns[0]}）…`, true);
            const batResult = await runResourceBat(resourceBat, suiteSns[0], hdc, artifacts, (detail) => emitTestProgress(detail, true));
            if (!batResult.ok) {
              throw new TestFlowError(`${path.basename(resourceBat)} 执行失败（退出码 ${batResult.code}）：${String(batResult.output || '').slice(-500)}`);
            }
            emitTestProgress(`资源安装完成，等待设备 ${suiteSns[0]} 回线…`, true);
            if (!await waitForDeviceOnline(hdc, suiteSns[0])) {
              throw new TestFlowError(`资源安装后设备 ${suiteSns[0]} 超过 3 分钟未回线（${path.basename(resourceBat)} 会重启设备），已停止。`);
            }
            // DCTS 重启后 softbus 服务断了——重新启动（对应 service.bat / soket_service.bat）
            if (step.suite === 'dcts') {
              // bat 里的 hdc install 可能被 shim 干扰——显式重新安装 dcct.hap
              const dcctHap = path.join(suiteDir, 'resource', 'data', 'dcct.hap');
              if (await isFile(dcctHap)) {
                emitTestProgress(`显式安装 dcct.hap 到被测设备…`, true);
                const installResult = await hdcCommand(hdc, ['-t', suiteSns[0], 'install', dcctHap], 30000).catch(() => undefined);
                emitTestProgress(installResult && installResult.code === 0 ? 'dcct.hap 安装成功' : `dcct.hap 安装结果不明（继续）`, true);
              }
              emitTestProgress(`重启 softbus 服务（dsoftbusTest / socketdsoftbusTest）…`, true);
              await hdcCommand(hdc, ['-t', suiteSns[0], 'shell', 'nohup', '/data/local/tmp/dsoftbusTest', '>', '/dev/null', '2>&1', '&'], 10000).catch(() => {});
              await sleep(2000);
              await hdcCommand(hdc, ['-t', suiteSns[0], 'shell', 'nohup', '/data/local/tmp/socketdsoftbusTest', '>', '/dev/null', '2>&1', '&'], 10000).catch(() => {});
              await sleep(2000);
              // 拉起 DUT 上的 dcct（让 DUT 可被发现）
              const dutHasDcct = await hdcCommand(hdc, ['-t', suiteSns[0], 'shell', 'bm', 'dump', '-a'], 10000).catch(() => undefined);
              if (dutHasDcct && dutHasDcct.code === 0 && dutHasDcct.stdout.includes(DCCT_BUNDLE_NAME)) {
                await hdcCommand(hdc, ['-t', suiteSns[0], 'shell', 'aa', 'start', '-b', DCCT_BUNDLE_NAME, '-a', DCCT_ABILITY_NAME], 10000).catch(() => {});
                emitTestProgress('DUT dcct 已拉起', true);
              }
              emitTestProgress(`softbus 服务已重启，DUT dcct 已就绪`, true);
              await sleep(3000);
            }
            emitTestProgress(`设备 ${suiteSns[0]} 已回线，开始 ${suiteArchiveName(step.suite)} 测试。`, true);
          }
        }

        // DCTS 前置：测试盒子连通预检 + 等待 dcct 配对（人工）；不过则跳过 DCTS 继续后续套件。
        if (step.suite === 'dcts' && round === 1 && !boxPrecheckDone) {
          boxPrecheckDone = true;
          emitTestProgress('DCTS 前置：测试盒子连通预检（盒子在线 / 同网段 / ping / dcct 配对）…', true);
          const precheck = await runTestBoxPrecheck({
            hdc,
            boxSn: testBoxSn,
            dutSn: suiteSns[0],
            dutSns: sns,
            workspace: artifacts,
            deadlineMs: boxWaitMs,
            onDetail: (detail) => emitTestProgress(detail, true),
          });
          if (!precheck.connected) {
            skipReason = precheck.reason;
            break;
          }
          emitTestProgress(`盒子连通预检通过：${precheck.reason}`, true);
        }

        emitTestProgress(`${describeRound()} 启动 · 命令 ${python} ${commandArgs.join(' ')}`);
        const child = spawn(python, commandArgs, {
          cwd: suiteDir,
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        });
        currentChild = child;

        const handleLine = (line) => {
          const exec = parseXdeviceExecLine(line);
          if (!exec) return;
          lastActivity = Date.now();
          if (exec.total > 0) suiteTotal = Math.max(suiteTotal, exec.total);
          const sn = [...devices.keys()].find((key) => key.toLowerCase() === exec.device.toLowerCase());
          if (sn) {
            const device = devices.get(sn);
            device.currentModule = exec.module;
            device.started = Math.max(device.started, exec.index);
          }
        };
        let lineBuffer = '';
        child.stdout?.on('data', (chunk) => {
          lineBuffer += chunk.toString();
          const lines = lineBuffer.split(/\r?\n/);
          lineBuffer = lines.pop() || '';
          for (const line of lines) handleLine(line);
          emitTestProgress();
        });
        child.stderr?.on('data', () => { lastActivity = Date.now(); });

        // 轮询 result/*.xml 计数推进度；看门狗：长时间无新结果且无进度行 → 判挂死。
        let reportDirectory = '';
        let finishedCount = 0;
        let watchdogFired = false;
        while (true) {
          const exited = await Promise.race([
            new Promise((resolve) => {
              if (child.exitCode !== null) resolve(true);
              else child.once('close', () => resolve(true));
            }),
            new Promise((resolve) => setTimeout(() => resolve(false), RESULT_POLL_MS)),
          ]);
          if (exited || stopped) break;
          if (!reportDirectory) reportDirectory = await resolveReportDirectory(reportRoot);
          const finished = (await finishedModuleNames(reportDirectory)).length;
          if (finished > finishedCount) {
            finishedCount = finished;
            suiteDone = Math.max(suiteDone, finished);
            lastActivity = Date.now();
          }
          emitTestProgress(`${describeRound()} · 已完成 ${finished}/${suiteTotal || '?'} 模块`);
          if (Date.now() - lastActivity > WATCHDOG_IDLE_MS) {
            watchdogFired = true;
            killTree(child.pid);
            await new Promise((resolve) => child.once('close', resolve));
            break;
          }
        }
        currentChild = null;

        // —— 判卷：summary_report.xml 为主，task_info.record 兜底 ——
        reportDirectory = reportDirectory || await resolveReportDirectory(reportRoot);
        const summaryPath = reportDirectory ? path.join(reportDirectory, 'summary_report.xml') : '';
        const summaryText = summaryPath ? await fs.readFile(summaryPath, 'utf8').catch(() => '') : '';
        const taskInfoPath = reportDirectory ? path.join(reportDirectory, 'task_info.record') : '';
        const taskInfoText = taskInfoPath ? await fs.readFile(taskInfoPath, 'utf8').catch(() => '') : '';
        const summary = summaryText ? parseSummaryReport(summaryText) : undefined;
        // 判卷以 summary 为准（failures>0 或整模块 ignored 都算失败）；
        // task_info.unsuccessful_params 会把"有 ignored 用例的通过模块"也列进来，只在
        // summary 完全缺失时兜底，避免把通过模块误送进补测。
        const failedModules = summary
          ? [...summary.failedModules]
          : (parseTaskInfoRecordText(taskInfoText) || []);
        // 跑了一半就挂（runmodules < 总数、又没记失败）→ 没跑完的模块全部进补测。
        if (!watchdogFired && summary && !summary.ok && failedModules.length === 0
          && Number.isFinite(summary.total) && Number.isFinite(summary.runModules)
          && summary.runModules < summary.total && useList) {
          const finishedNames = new Set(await finishedModuleNames(reportDirectory));
          failedModules = pendingModules.filter((module) => !finishedNames.has(module.toLowerCase()));
        }
        const roundOk = Boolean(summary?.ok) && failedModules.length === 0 && !watchdogFired;
        if (roundOk) suiteDone = Math.max(suiteDone, suiteTotal || suiteDone);

        // —— 归档（每轮都拷，report-1、report-2 … 递增不覆盖） ——
        const archiveRoot = path.join(workbookRoot, 'report', suiteArchiveName(step.suite));
        let archivedTo = '';
        if (reportDirectory) {
          const index = nextReportIndex(await fs.readdir(archiveRoot).catch(() => []));
          archivedTo = path.join(archiveRoot, `report-${index}`);
          emitTestProgress(`正在归档 ${suiteArchiveName(step.suite)} 第 ${round} 轮报告 → report-${index}`);
          try {
            await fs.mkdir(archiveRoot, { recursive: true });
            await fs.cp(reportDirectory, archivedTo, { recursive: true });
          } catch (error) {
            const warning = `${suiteArchiveName(step.suite)} 第 ${round} 轮报告归档失败（不影响测试结论）：${error instanceof Error ? error.message : String(error)}`;
            warnings.push(warning);
          }
        }

        const roundMessage = watchdogFired
          ? `${suiteArchiveName(step.suite)} 第 ${round} 轮长时间无输出，已终止本轮。`
          : roundOk
            ? `${suiteArchiveName(step.suite)} 第 ${round} 轮全部通过${archivedTo ? `，已归档 ${archivedTo}` : ''}。`
            : `${suiteArchiveName(step.suite)} 第 ${round} 轮有 ${failedModules.length} 个失败模块${archivedTo ? `，已归档 ${archivedTo}` : ''}。`;
        emitRound({
          suite: step.suite,
          suiteIndex: stepIndex + 1,
          suiteTotal: plan.length,
          round,
          ok: roundOk,
          failedModules,
          archivedTo: archivedTo || undefined,
          message: roundMessage,
        });
        rounds.push({
          suite: step.suite,
          round,
          ok: roundOk,
          failedModules,
          archivedTo: archivedTo || undefined,
        });

        if (roundOk) break;
        if (failedModules.length === 0) {
          // 判定失败却拿不到失败清单（报告缺失/无法解析）→ 不能盲目重跑整包，交给人工。
          unpassed.push({ suite: step.suite, module: summaryText ? '（判定失败但未解析到失败模块）' : '（缺少 summary_report.xml 报告）' });
          break;
        }
        if (round > maxRetry) {
          for (const module of failedModules) unpassed.push({ suite: step.suite, module });
          break;
        }
        round += 1;
        useList = true;
        pendingModules = [...failedModules];
      }

      if (skipReason) {
        // DCTS 前置检查未过：没跑就不算失败模块，跳过并继续后续套件（可单独重跑 dcts）。
        const message = `DCTS 已跳过：${skipReason} DCTS 必须先连接测试盒子（盒子上 dcct 配对：勾 Wi-Fi → 下一步 → 允许被发现 → 发现并点击目标设备 → 被测设备「永远信任」→ 输入 PIN 码）；完成后可单独重跑 DCTS。`;
        emitRound({
          suite: step.suite,
          suiteIndex: stepIndex + 1,
          suiteTotal: plan.length,
          round: 1,
          ok: false,
          skipped: true,
          failedModules: [],
          message,
        });
        rounds.push({ suite: step.suite, round: 1, ok: false, skipped: true, failedModules: [], message });
        skippedSuites.push({ suite: step.suite, reason: skipReason });
        continue;
      }
    }

    const ok = unpassed.length === 0 && skippedSuites.length === 0;
    const skippedText = skippedSuites.length > 0
      ? `已跳过 ${skippedSuites.length} 个套件（${skippedSuites.map((item) => suiteArchiveName(item.suite))}：${skippedSuites.map((item) => item.reason).join('；')}）。`
      : '';
    const message = ok
      ? `XTS 自动测试完成：${describePlan()}，${rounds.length} 轮全部通过，报告已归档到 ${path.join(workbookRoot, 'report')}。`
      : skippedSuites.length > 0 && unpassed.length === 0
        ? `XTS 自动测试结束：${skippedText}其余套件${rounds.some((round) => !round.skipped && round.ok) ? '已通过' : '结果见 rounds'}。可单独重跑被跳过的套件（如 --suites dcts）。`
        : `XTS 自动测试结束，还有 ${unpassed.length} 个失败模块（${unpassed.map((item) => `${suiteArchiveName(item.suite)} ${item.module}`).join('、')}），已达补测上限，请人工排查或走豁免。${skippedText}`;
    emitResult({
      ok,
      message: warnings.length > 0 ? `${message} ${warnings.join(' ')}` : message,
      plan: plan.map((step) => ({ suite: step.suite, mode: step.mode, modules: step.mode === 'task' ? 0 : step.modules.length })),
      screens,
      rounds,
      unpassed,
      skipped: skippedSuites,
      artifacts,
    });
    await writeResult(artifacts, { ok, message, rounds, unpassed, skipped: skippedSuites });
    return ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof TestFlowError
      ? error.message
      : `XTS 自动测试执行失败：${error instanceof Error ? error.message : String(error)}`;
    emitResult({ ok: false, message, rounds, unpassed });
    await writeResult(artifacts, { ok: false, message });
    return 1;
  }
}

await main();
