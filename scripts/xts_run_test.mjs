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
  stepReportTag,
  suiteArchiveName,
  suitePlan,
} from './xts_test_logic.mjs';
import { writeSynthesizedReportFiles } from './xts_report_writer.mjs';

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

const WATCHDOG_IDLE_MS = 30 * 60 * 1000;
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
--only-failed 增量模式：对选中的每个套件，读最新归档报告（<workbook>/report/<SUITE>/report-<n>），
             只跑「失败 + 没跑完」的模块；最新报告全部通过的套件自动跳过。ssts 是任务模式，仍整跑。
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

/** xdevice 套件目录名（--testcases 应指向这些目录的父目录）。 */
const SUITE_DIR_NAMES = ['ssts', 'hats', 'dcts', 'acts'];

/**
 * 归一化「测试用例路径」。
 * 用户常常把 `…\testcase\ssts`（套件目录，里面有 run.bat）或它的 config 子目录填进来，
 * 而脚本要的是**套件根** `…\testcase`；不归一化就会报「测试用例路径下没有 ssts 套件目录：
 * …\testcase\ssts\ssts」，看起来像 SSTS 跑不了，其实只是路径多了一层。
 */
async function resolveSuiteRoot(rawPath) {
  const requested = path.resolve(rawPath);
  let directory = requested;
  for (let depth = 0; depth < 4; depth += 1) {
    if (await isDirectory(path.join(directory, 'ssts', 'config'))) {
      return { root: directory, note: directory === requested ? '' : `测试用例路径已归一到套件根：${requested} → ${directory}` };
    }
    const isSuite = SUITE_DIR_NAMES.includes(path.basename(directory).toLowerCase())
      && (await isFile(path.join(directory, 'config', 'user_config.xml')) || await isFile(path.join(directory, 'run.bat')));
    if (isSuite) {
      const parent = path.dirname(directory);
      return { root: parent, note: `测试用例路径指向套件目录，已按套件根处理：${requested} → ${parent}` };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { root: requested, note: '' };
}

/**
 * 确认 `python -m xdevice` 可用；不可用时按 run.bat 的做法就地修复一次：
 * 保证 `python -m xdevice` 可用，且用的是**该套件自己**那份离线包。
 * ① 缺 pkg_resources（setuptools）先补；
 * ② 已装 xdevice 与 <suite>/tools/xdevice-*.tar.gz 的版本指纹不一致 → 卸载重装该套件的整套离线包；
 * ③ 装完再自检，仍失败就把解释器路径与真实报错抛出来。
 *
 * 版本规律（2026-11-25 实测，见 AGENTS.md）：**ssts 是旧版，acts/acts-validator/hats/dcts 是新版**。
 * 旧版报告 = details/failures/passes_report.html；新版 = static/ + summary_report.html。
 * 这是上游套件包自带的差异，不是缺陷，不要试图统一。
 */
/**
 * 已装 xdevice 的报告版本指纹：新版（acts/hats/dcts 包）的 result_reporter 里有
 * `_generate_test_report` 且走它；旧版（ssts 包）只有 `_generate_vision_reports`。
 * 不能用 template/static 目录判断——重装其它套件版本后目录会残留（2026-11-25 实测）。
 */
const XDEVICE_VERSION_PROBE = [
  '-c',
  'import xdevice,os;'
  + 'f=os.path.join(os.path.dirname(xdevice.__file__),"_core","report","result_reporter.py");'
  + 't=open(f,encoding="utf-8").read();'
  + 'print("new" if "self._generate_test_report()" in t else "old")',
];

async function ensureXdeviceReady({ python, testcaseRoot, suite, onDetail }) {
  // ohos 一起 import：单装 xdevice 主包会让 ohos 插件与 DeviceTestType 常量不匹配，
  // `run` 起来就 AttributeError: DeviceTestType has no attribute 'validator_test'（2026-11-25 实测）。
  const probe = ['-c', 'import xdevice, pkg_resources, ohos; print("xdevice-ok")'];
  const fpProbe = XDEVICE_VERSION_PROBE;
  const suiteTools = path.join(testcaseRoot, suite, 'tools');
  const tarballs = [];
  for (const name of await fs.readdir(suiteTools).catch(() => [])) {
    if (name.endsWith('.tar.gz') || name.endsWith('.egg')) tarballs.push(path.join(suiteTools, name));
  }
  // 该套件期望的报告版本：新版（acts/hats/dcts）= result_reporter 里有 _generate_test_report；ssts 版没有。
  const coreTarball = tarballs.find((item) => /xdevice-\d/.test(path.basename(item)));
  const expectNewReport = await tarHasNewReporter(coreTarball);

  const first = await runCommand(python, probe, { timeoutMs: 60000 });
  let needInstall = first.code !== 0;
  if (!needInstall) {
    const fp = await runCommand(python, fpProbe, { timeoutMs: 60000 });
    const installedNew = /new/.test(fp.stdout);
    if (installedNew !== expectNewReport) {
      onDetail?.(`已装 xdevice 的报告版本与该套件(${suite})不一致（该套件需要${expectNewReport ? '新版' : '旧版(ssts)'}报告，当前是${installedNew ? '新版' : '旧版'}），重装 ${suite}/tools 里的离线包…`);
      needInstall = true;
    }
  }
  if (!needInstall) return;

  if (first.code !== 0) {
    const reason = (first.stderr || first.stdout || `退出码 ${first.code}`).trim().split(/\r?\n/).filter(Boolean).pop() || '';
    onDetail?.(`xdevice 自检未通过（${reason}），按 run.bat 的方式修复依赖…`);
    await runCommand(python, ['-m', 'pip', 'install', '--user', 'setuptools==75.8.0',
      '--timeout', '20', '--retries', '1', '--disable-pip-version-check'], { timeoutMs: 240000 });
  }
  await runCommand(python, ['-m', 'pip', 'uninstall', '-y', 'xdevice', 'xdevice-ohos', 'xdevice-ohos-plugin', 'xdevice-devicetest'],
    { timeoutMs: 120000 });
  for (const tarball of tarballs) {
    onDetail?.(`安装离线包 ${path.basename(tarball)}`);
    await runCommand(python, ['-m', 'pip', 'install', '--user', tarball, '--disable-pip-version-check'], { timeoutMs: 300000 });
  }
  const second = await runCommand(python, probe, { timeoutMs: 60000 });
  if (second.code === 0) {
    onDetail?.(`xdevice 依赖已就绪（${suite} 版）。`);
    return;
  }
  const detail = (second.stderr || second.stdout || '').trim().slice(-600);
  throw new TestFlowError(
    `python -m xdevice 无法启动（解释器：${python}）。自检输出：${detail || '（无输出）'}。`
    + `可在命令行手动执行：${python} -m pip install --user setuptools==75.8.0`
    + (tarballs[0] ? ` 与 ${python} -m pip install --user "${tarballs[0]}"` : '')
    + ' 后重试。',
  );
}

/** tarball 里的 xdevice 是否是新版报告（result_reporter.py 里有 _generate_test_report）。 */
async function tarHasNewReporter(tarball) {
  if (!tarball) return false;
  const dir = path.join(path.dirname(tarball), '.probe-xdevice');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const extract = await runCommand('tar', ['xzf', tarball, '-C', dir], { timeoutMs: 120000 });
  if (extract.code !== 0) return false;
  const found = await findFile(dir, 'result_reporter.py');
  const text = found ? await fs.readFile(found, 'utf8').catch(() => '') : '';
  await fs.rm(dir, { recursive: true, force: true });
  return text.includes('self._generate_test_report()');
}

async function findFile(dir, name) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = await findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) return full;
  }
  return '';
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

/** result/ 里「真正跑过且有用例」的模块（根节点 tests>0 的 result XML）；文件名小写。 */
async function finishedAndPassedModules(reportDirectory) {
  const dir = reportDirectory ? path.join(reportDirectory, REPORT_RESULT_DIR) : '';
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const passed = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.xml')) continue;
    const text = await fs.readFile(path.join(dir, entry.name), 'utf8').catch(() => '');
    const tests = Number((text.match(/<testsuites\b[^>]*?\stests="(\d+)"/) ?? [])[1]);
    if (Number.isFinite(tests) && tests > 0) passed.add(entry.name.slice(0, -4).toLowerCase());
  }
  return passed;
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
 * 执行套件 resource/ 下的资源安装 bat（如 dcts_resource.bat）。
 * 套件原文件不动：整目录复制到 <workspace>/resource-<suite>，把副本里所有 .bat 的裸 `hdc`
 * 改成 `"<hdc.exe>" -t <sn>`，再跑副本入口。
 *
 * 为什么不用 hdc.cmd shim 注入 PATH：批处理里裸调用 `hdc`（无 call）且命中 .cmd 时，
 * cmd 会把控制权交给 shim 而**不返回**——dcts_resource.bat 第一行 `hdc shell mount` 就结束，
 * 后面的 push/install/reboot 全不执行，退出码还是 0（2026-11-25 实测：DCTS 6 个 SoftBus
 * 模块连续失败 3 轮，设备上根本没有 dsoftbusTest/test.wav）。
 * `@start permission.bat` 拉起的子窗口 cwd 继承副本目录，同样命中改好的副本。
 * bat 结尾的 `pause` 与中间的 `timeout` 在 stdin=ignore 下 EOF 放行，不会卡住。
 */
async function runResourceBat(batFile, sn, hdc, workspace, onDetail) {
  const realHdc = await resolveHdcExecutable(hdc);
  const sourceDir = path.dirname(batFile);
  const targetDir = path.join(workspace, `resource-${path.basename(sourceDir)}`);
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });

  if (realHdc) {
    const prefix = `"${realHdc}" -t ${sn}`;
    for (const name of await fs.readdir(targetDir)) {
      if (!name.toLowerCase().endsWith('.bat')) continue;
      const file = path.join(targetDir, name);
      const text = await fs.readFile(file, 'utf8');
      // 行首/空白后的裸 hdc；已是绝对路径或带引号的不动。
      const patched = text.replace(/(^|\s)hdc(?=\s)/g, `$1${prefix}`);
      if (patched !== text) await fs.writeFile(file, patched, 'utf8');
    }
    onDetail?.(`已把 resource 副本里的 hdc 固定到设备 ${sn}：${targetDir}`);
  } else {
    onDetail?.('未解析到 hdc.exe 路径，bat 里的 hdc 按默认目标执行（请确保目标机是 hdc 默认设备）。');
  }

  const runBat = path.join(targetDir, path.basename(batFile));
  onDetail?.(`执行 ${path.basename(runBat)} 安装测试工具（目标设备 ${sn}，会重启设备并等待回线）…`);
  const result = await runCommand('cmd', ['/c', runBat], {
    timeoutMs: RESOURCE_BAT_TIMEOUT_MS,
    spawnOptions: {
      cwd: targetDir,
      env: process.env,
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

/**
 * 布局 JSON 摊平成节点列表（type/text/checked/中心坐标）。
 */
function flattenUiTree(node, results = []) {
  if (!node || typeof node !== 'object') return results;
  const attrs = node.attributes ?? node;
  const bounds = parseBounds(attrs.bounds);
  results.push({
    type: String(attrs.type ?? ''),
    text: String(attrs.text ?? '').trim(),
    checked: attrs.checked === true || attrs.checked === 'true',
    bounds,
    x: bounds ? bounds.x : 0,
    y: bounds ? bounds.y : 0,
  });
  for (const child of node.children ?? []) flattenUiTree(child, results);
  return results;
}

async function dumpUiNodes(hdc, sn) {
  const raw = await dumpBoxLayout(hdc, sn).catch(() => '');
  if (!raw || !raw.trim().startsWith('{')) return [];
  try { return flattenUiTree(JSON.parse(raw)); } catch { return []; }
}

/**
 * dcct 的系统权限弹窗放行（bm clean 清应用数据会连授权一起清掉，dcct 首次启动会连弹
 * 「使用多设备协同？」「访问你的位置？」等多道系统弹窗挡住页面）——按优先级点放行按钮，
 * 循环清完弹窗队列。位置类弹窗优先「仅使用期间允许」，没有再退「允许本次使用」。
 */
const PERMISSION_ALLOW_TEXTS = ['仅使用期间允许', '使用期间允许', '始终允许', '允许本次使用', '允许'];
/** 非权限的系统提示框（bm clean 后启动 dcct 常弹「无法打开此文件」），点掉即可继续。 */
const BENIGN_NOTICE_TEXTS = ['知道了', '确定', '好的', '关闭'];
async function dismissDcctPermissionDialog(hdc, sn, onDetail) {
  for (let round = 0; round < 8; round += 1) {
    const nodes = await dumpUiNodes(hdc, sn);
    const allow = nodes.find((node) => node.type === 'Button' && PERMISSION_ALLOW_TEXTS.includes(node.text));
    if (allow) {
      onDetail?.(`dcct 弹出系统权限弹窗，点「${allow.text}」…`);
      await uitestClick(hdc, sn, allow.x, allow.y);
      await sleep(1500);
      continue;
    }
    // 权限弹窗后面常常还跟一个「无法打开此文件 / 知道了」之类的提示框，它没有「允许/禁止」
    // 这类按钮，只按权限文案匹配会漏掉，导致后面找不到 Wi-Fi/下一步（2026-11-25 实测）。
    const notice = nodes.find((node) => node.type === 'Button' && BENIGN_NOTICE_TEXTS.includes(node.text));
    if (notice) {
      onDetail?.(`dcct 弹出提示框，点「${notice.text}」…`);
      await uitestClick(hdc, sn, notice.x, notice.y);
      await sleep(1500);
      continue;
    }
    return round > 0;
  }
  return true;
}

/**
 * 唤醒并解锁屏幕（盒子/被测设备锁屏极快，每次交互前都要做）。
 * 先唤醒后判断：已解锁就**不要滑动**（滑动会把 dcct 页面滚走），只有真锁屏才上滑。
 * 返回 true = 解锁后布局里已不是锁屏。
 */
async function wakeUnlockScreen(hdc, sn, swipeArgs, onDetail) {
  const wake = () => hdcCommand(hdc, ['-t', sn, 'shell', 'power-shell', 'wakeup'], 5000).catch(() => {});
  await wake();
  await sleep(800);
  let nodes = await dumpUiNodes(hdc, sn);
  if (!nodes.some((node) => node.text === '上滑解锁')) return true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    onDetail?.(`屏幕在锁屏，上滑解锁（第 ${attempt + 1} 次）…`);
    await hdcCommand(hdc, ['-t', sn, 'shell', 'uitest', 'uiInput', 'swipe', ...(swipeArgs ?? ['400', '1100', '400', '300', '300'])], 8000).catch(() => {});
    await sleep(1200);
    await wake();
    await sleep(600);
    await hdcCommand(hdc, ['-t', sn, 'shell', 'power-shell', 'setmode', '602'], 5000).catch(() => {});
    nodes = await dumpUiNodes(hdc, sn);
    if (!nodes.some((node) => node.text === '上滑解锁')) return true;
    await sleep(1000);
  }
  return false;
}

/** 找 dcct 配置页第 1 页的 Wi-Fi 开关（Toggle 紧挨着 Wi-Fi 文字行）。 */
/** 开关节点：Toggle/Switch/CheckBox（不同设备/版本渲染类型不同）。 */
function isToggleNode(node) {
  return node.type === 'Toggle' || node.type === 'Switch' || node.type === 'CheckBox';
}

/** 开关与标签同行判定（宽屏上开关在行最右侧，但中心 y 一致）。 */
function sameRow(a, b) {
  return Math.abs(a.y - b.y) < 80;
}

function findWifiToggle(nodes) {
  const wifiText = nodes.find((node) => node.text === 'Wi-Fi');
  if (!wifiText) return undefined;
  return nodes.find((node) => node !== wifiText && isToggleNode(node) && sameRow(node, wifiText));
}

/** 找「允许被发现」开关。 */
function findDiscoverableToggle(nodes) {
  const label = nodes.find((node) => node.text === '允许被发现');
  if (!label) return undefined;
  return nodes.find((node) => node !== label && isToggleNode(node) && sameRow(node, label));
}

/**
 * 把 dcct 从第 1 页（组网方式选择）推进到第 2 页（允许被发现/设备列表），
 * 并确保 Wi-Fi 开关与「允许被发现」开关都已打开。每步点击后都回读布局验证。
 */
async function prepareDcctPage(hdc, sn, swipeArgs, tag, onDetail) {
  if (!await wakeUnlockScreen(hdc, sn, swipeArgs, onDetail)) {
    return { ok: false, reason: `${tag}屏幕无法解锁（锁屏超时）` };
  }
  await hdcCommand(hdc, ['-t', sn, 'shell', 'aa', 'start', '-b', DCCT_BUNDLE_NAME, '-a', DCCT_ABILITY_NAME], 10000).catch(() => {});
  // 等 dcct 前台起来（冷启动可能要几秒；权限弹窗挡路时先放行）
  let nodes = [];
  for (let wait = 0; wait < 5; wait += 1) {
    await sleep(2000);
    nodes = await dumpUiNodes(hdc, sn);
    if (nodes.some((node) => node.text.includes('请选择组网方式') || node.text === '允许被发现')) break;
    if (await dismissDcctPermissionDialog(hdc, sn, onDetail)) {
      nodes = await dumpUiNodes(hdc, sn);
      if (nodes.some((node) => node.text.includes('请选择组网方式') || node.text === '允许被发现')) break;
    }
    await hdcCommand(hdc, ['-t', sn, 'shell', 'aa', 'start', '-b', DCCT_BUNDLE_NAME, '-a', DCCT_ABILITY_NAME], 10000).catch(() => {});
    onDetail?.(`${tag} dcct 未到前台，重试拉起…`);
  }

  // —— 第 1 页：勾 Wi-Fi → 下一步 ——
  if (nodes.some((node) => node.text.includes('请选择组网方式'))) {
    const wifiToggle = findWifiToggle(nodes);
    if (!wifiToggle) return { ok: false, reason: `${tag} dcct 第 1 页没有 Wi-Fi 开关` };
    if (!wifiToggle.checked) {
      for (let retry = 0; retry < 2; retry += 1) {
        await uitestClick(hdc, sn, wifiToggle.x, wifiToggle.y);
        await sleep(1500);
        nodes = await dumpUiNodes(hdc, sn);
        if (findWifiToggle(nodes)?.checked) break;
      }
      if (!findWifiToggle(nodes)?.checked) return { ok: false, reason: `${tag} Wi-Fi 开关点击后未变为已选` };
    }
    const nextButton = nodes.find((node) => node.text === '下一步' && node.type === 'Button');
    if (!nextButton) return { ok: false, reason: `${tag} dcct 第 1 页没有「下一步」按钮` };
    await uitestClick(hdc, sn, nextButton.x, nextButton.y);
    // 页面切换可能比一次 dump 慢——轮询等「允许被发现」出现
    nodes = [];
    for (let wait = 0; wait < 5; wait += 1) {
      await sleep(2000);
      nodes = await dumpUiNodes(hdc, sn);
      if (nodes.some((node) => node.text === '允许被发现')) break;
    }
    if (!nodes.some((node) => node.text === '允许被发现')) return { ok: false, reason: `${tag} 点击「下一步」后没有进入设备列表页` };
  }

  // —— 第 2 页：确保「允许被发现」打开（dump 偶发不完整——找不到开关时重试再判） ——
  let discoverable = findDiscoverableToggle(nodes);
  for (let retry = 0; !discoverable && retry < 3; retry += 1) {
    await sleep(1500);
    nodes = await dumpUiNodes(hdc, sn);
    discoverable = findDiscoverableToggle(nodes);
  }
  if (!discoverable) return { ok: false, reason: `${tag} dcct 设备列表页没有「允许被发现」开关` };
  if (!discoverable.checked) {
    for (let retry = 0; retry < 2; retry += 1) {
      await uitestClick(hdc, sn, discoverable.x, discoverable.y);
      await sleep(1500);
      nodes = await dumpUiNodes(hdc, sn);
      if (findDiscoverableToggle(nodes)?.checked) break;
    }
    if (!findDiscoverableToggle(nodes)?.checked) return { ok: false, reason: `${tag} 「允许被发现」开关点击后未变为已选` };
  }
  return { ok: true, nodes };
}

/**
 * 自动执行 dcct 配对流程（双端 uitest 驱动，逐步验证，不靠猜）。
 * 流程：DUT/盒子各自 dcct 配置页推进（Wi-Fi → 下一步 → 允许被发现）→ 盒子发现
 *       → 逐个候选点击 + 在目标 DUT 上验证信任弹窗（同型号多设备时确定唯一目标）
 *       → DUT 点「始终信任」→ 聚合 DUT 分离式连接码数字 → 盒子软键盘逐位输入
 *       → 连接确认。任一步验证不过 → 配对失败 → 跳过 DCTS。
 */
async function performDcctPairing({ hdc, boxSn, dutSn, dutIdentifiers, workspace, deadlineMs, onDetail }) {
  const startedAt = Date.now();
  const remaining = () => Math.max(0, deadlineMs - (Date.now() - startedAt));

  // —— 盒子侧：配置页推进（被测设备不用启动 dcct：信任弹窗与连接码是系统级弹窗，会自己出现） ——
  onDetail?.('盒子：dcct 配置页推进（Wi-Fi → 下一步 → 允许被发现）…');
  const boxPrep = await prepareDcctPage(hdc, boxSn, ['400', '1100', '400', '300', '300'], '盒子', onDetail);
  if (!boxPrep.ok) return { connected: false, reason: boxPrep.reason };
  if (remaining() <= 0) return { connected: false, reason: '配对超时（配置页阶段耗尽时限）' };

  // —— DUT 侧：只推进 dcct 配置页到第 2 页并打开「允许被发现」，不做任何配对操作
  // （发现/点击目标在盒子上，信任弹窗与连接码是系统级弹窗）。DUT 重启后 dcct 会回到
  // 第 1 页，「允许被发现」是关的——此时盒子发起连接不会触发信任弹窗（实测 2026-11-18）。
  onDetail?.('被测设备：推进 dcct 配置页并打开「允许被发现」…');
  const dutPrep = await prepareDcctPage(hdc, dutSn, ['500', '1200', '500', '300', '300'], '被测设备', onDetail);
  if (!dutPrep.ok) return { connected: false, reason: dutPrep.reason };
  if (remaining() <= 0) return { connected: false, reason: '配对超时（被测设备配置页阶段耗尽时限）' };

  // —— 盒子：收集候选。可用设备列表只显示 3 条且多台同名设备会轮换——条目名全是
  // 「Nurse Terminal」没法区分，改用条目下方的唯一设备 ID 行（长十六进制串）识别，
  // 并滑动列表补扫屏幕外的条目、按 ID 去重合并。
  const scanDeviceEntries = (nodes) => {
    const availableLabel = nodes.find((node) => node.text === '可用设备');
    return nodes.filter((node) => /^[0-9a-f]{10,}$/i.test(node.text) && (!availableLabel || node.y > availableLabel.y))
      .filter((node, index, all) => all.findIndex((item) => item.text === node.text) === index);
  };
  const swipeList = async (fromY, toY) => {
    await hdcCommand(hdc, ['-t', boxSn, 'shell', 'uitest', 'uiInput', 'swipe', '400', String(fromY), '400', String(toY), '600'], 8000).catch(() => {});
    await sleep(1500);
  };
  const collectCandidates = async () => {
    for (let dump = 0; dump < 4; dump += 1) {
      await wakeUnlockScreen(hdc, boxSn, ['400', '1100', '400', '300', '300'], onDetail);
      const nodes = await dumpUiNodes(hdc, boxSn);
      const merged = scanDeviceEntries(nodes);
      if (merged.length > 0) {
        // 滑动补扫屏幕外的条目（列表每次只渲染可见的几条）
        for (let scroll = 0; scroll < 2; scroll += 1) {
          await swipeList(1150, 500);
          const more = scanDeviceEntries(await dumpUiNodes(hdc, boxSn));
          for (const item of more) if (!merged.some((m) => m.text === item.text)) merged.push(item);
          if (more.length === 0) break;
        }
        await swipeList(700, 1200);
        return merged;
      }
      // 列表页发现按钮有两态：「发现」（未开始）/「停止」（发现进行中）——
      // 没有条目时：有「发现」就点开始，「停止」态先停再等下一轮点「发现」。
      const discover = nodes.find((node) => node.text === '发现');
      const stop = nodes.find((node) => node.text === '停止');
      if (discover) {
        await uitestClick(hdc, boxSn, discover.x, discover.y);
        await sleep(4000);
      } else if (stop) {
        await uitestClick(hdc, boxSn, stop.x, stop.y);
        await sleep(2000);
      } else {
        await sleep(3000);
      }
    }
    return [];
  };

  // —— 收集候选 → 逐个试 → 一批都不是目标就重启一轮发现再扫。
  // 可用设备列表只显示 3 条且会轮换，目标条目不一定恰好在扫描瞬间可见（实测 2026-11-18）。
  let trusted = false;
  let rescanCount = 0;
  for (let cycle = 0; cycle < 4 && !trusted && remaining() > 0; cycle += 1) {
    let candidates = [];
    for (let attempt = 0; attempt < 3 && candidates.length === 0; attempt += 1) {
      candidates = await collectCandidates();
      if (candidates.length === 0) {
        onDetail?.('盒子上没有目标候选设备，重新推进 dcct 配置页…');
        const rep = await prepareDcctPage(hdc, boxSn, ['400', '1100', '400', '300', '300'], '盒子', onDetail);
        if (!rep.ok) return { connected: false, reason: rep.reason };
      }
    }
    if (candidates.length === 0) break;
    onDetail?.(cycle === 0
      ? `盒子发现 ${candidates.length} 台同名设备，逐个候选点击并在目标被测设备上验证…`
      : `第 ${cycle + 1} 轮扫描（发现列表会轮换），逐个候选验证…`);

    for (let index = 0; index < candidates.length && !trusted; index += 1) {
      if (remaining() <= 0) break;
      const candidate = candidates[index];
      onDetail?.(`点击候选 ${index + 1}/${candidates.length}（${candidate.text} @ y=${candidate.y}）…`);
      await wakeUnlockScreen(hdc, boxSn, ['400', '1100', '400', '300', '300'], onDetail);
      // 唤醒滑动可能把界面顶回去——按唯一 ID 重新定位候选（列表轮换时可能滚到屏幕外）
      const nodes = await dumpUiNodes(hdc, boxSn);
      const label = nodes.find((node) => node.text === '可用设备');
      let target = nodes.find((node) => node.text === candidate.text && (!label || node.y > label.y));
      if (!target) {
        await swipeList(1150, 500);
        const scrolled = await dumpUiNodes(hdc, boxSn);
        const label2 = scrolled.find((node) => node.text === '可用设备');
        target = scrolled.find((node) => node.text === candidate.text && (!label2 || node.y > label2.y));
      }
      if (!target) {
        rescanCount += 1;
        if (rescanCount > 2) break;
        onDetail?.('候选条目不在列表里（列表刷新过），重新发现…');
        candidates = await collectCandidates();
        if (candidates.length === 0) break;
        index -= 1;
        continue;
      }
      await uitestClick(hdc, boxSn, target.x, target.y);
      // 目标 DUT 上等信任弹窗（6s 内出现才算点对了设备）；DUT 屏幕锁定时先唤醒解锁
      let trustButton;
      for (let wait = 0; wait < 3 && !trustButton; wait += 1) {
        await sleep(1500);
        await wakeUnlockScreen(hdc, dutSn, ['500', '1200', '500', '300', '300']).catch(() => {});
        const dutNodes = await dumpUiNodes(hdc, dutSn);
        trustButton = dutNodes.find((node) => node.text === '始终信任');
        if (!trustButton && dutNodes.some((node) => node.text.includes('是否信任此应用'))) {
          trustButton = dutNodes.find((node) => node.text.includes('信任') && node.type === 'Button' && !node.text.includes('不信任'));
        }
      }
      if (trustButton) {
        onDetail?.(`目标被测设备弹出信任请求，点击「${trustButton.text}」…`);
        await uitestClick(hdc, dutSn, trustButton.x, trustButton.y);
        trusted = true;
        break;
      }
      // 不是目标设备：盒子可能停在连接码页 → 取消回列表
      const boxNodes = await dumpUiNodes(hdc, boxSn);
      if (boxNodes.some((node) => node.text === '请输入对端设备上显示的连接码')) {
        const cancel = boxNodes.find((node) => node.text === '取消' && node.type === 'Button');
        if (cancel) await uitestClick(hdc, boxSn, cancel.x, cancel.y);
        await sleep(1500);
      }
    }
    if (!trusted) {
      onDetail?.('这一批候选都不是目标被测设备，重启一轮发现再扫…');
      const cycleNodes = await dumpUiNodes(hdc, boxSn);
      const stop = cycleNodes.find((node) => node.text === '停止');
      if (stop) {
        await uitestClick(hdc, boxSn, stop.x, stop.y);
        await sleep(1500);
      }
      const disc = (await dumpUiNodes(hdc, boxSn)).find((node) => node.text === '发现');
      if (disc) {
        await uitestClick(hdc, boxSn, disc.x, disc.y);
        await sleep(4000);
      }
    }
  }
  if (!trusted) return { connected: false, reason: '候选设备上都没有出现目标被测设备的信任弹窗（发现列表已重启重试多轮），无法确定目标设备' };

  // —— 连接码阶段：DUT 显示分离式数字 → 盒子软键盘逐位输入（弹窗 ~30s 超时） ——
  onDetail?.('读取被测设备连接码并在盒子上输入…');
  let pin = '';
  const pinDeadline = Date.now() + 12000;
  while (Date.now() < pinDeadline && !pin) {
    await wakeUnlockScreen(hdc, dutSn, ['500', '1200', '500', '300', '300']).catch(() => {});
    const dutNodes = await dumpUiNodes(hdc, dutSn);
    if (dutNodes.some((node) => node.text === '连接码')) {
      pin = dutNodes.filter((node) => /^[0-9]$/.test(node.text)).sort((a, b) => a.x - b.x).map((node) => node.text).join('');
    }
    if (!pin) await sleep(1500);
  }
  if (!pin) return { connected: false, reason: '点击「始终信任」后没读到连接码（配对页未出现或已超时）' };
  onDetail?.(`连接码 ${pin}，盒子上逐位输入…`);

  let entered = false;
  const inputDeadline = Date.now() + 20000;
  while (Date.now() < inputDeadline && !entered) {
    const boxNodes = await dumpUiNodes(hdc, boxSn);
    if (!boxNodes.some((node) => node.text === '请输入对端设备上显示的连接码')) break;
    const field = boxNodes.find((node) => node.type === 'TextInput');
    if (!field) break;
    await uitestClick(hdc, boxSn, field.x, field.y);
    await sleep(1200);
    const pageNodes = await dumpUiNodes(hdc, boxSn);
    const digitFilter = (node) => /^[0-9]$/.test(node.text) && field.bounds && node.y > field.bounds.y + 60;
    let keyNodes = pageNodes.filter(digitFilter);
    // QWERTY 键盘上数字只是字母键上方的小号长按提示（高 ~14px），直接点会按到字母；
    // 检测到数字提示与字母键同行共存时先点「?123」切到数字键盘再取按键。
    const qwertyLetters = pageNodes.filter((node) => /^[a-z]$/.test(node.text) && field.bounds && node.y > field.bounds.y + 60);
    if (keyNodes.length > 0 && qwertyLetters.length > 0
      && keyNodes.some((digit) => qwertyLetters.some((letter) => letter.x < digit.x + 20 && digit.x < letter.x + 20))) {
      const modeKey = pageNodes.find((node) => node.text === '?123' && field.bounds && node.y > field.bounds.y + 60);
      if (modeKey) {
        onDetail?.('软键盘是字母键盘，点「?123」切换数字键盘…');
        await uitestClick(hdc, boxSn, modeKey.x, modeKey.y);
        await sleep(1200);
        keyNodes = (await dumpUiNodes(hdc, boxSn)).filter(digitFilter);
      }
    }
    if (keyNodes.length === 0) { await sleep(1500); continue; }
    for (const digit of pin) {
      const key = keyNodes.find((node) => node.text === digit);
      if (!key) { onDetail?.(`软键盘上没有数字键 ${digit}（可能是符号键盘），跳过输入…`); break; }
      await uitestClick(hdc, boxSn, key.x + 4, key.y + 22);
      await sleep(450);
    }
    await sleep(1500);
    const after = await dumpUiNodes(hdc, boxSn);
    entered = !after.some((node) => node.text === '请输入对端设备上显示的连接码')
      || after.some((node) => /已连接|连接成功/i.test(node.text))
      || (after.find((node) => node.type === 'TextInput')?.text ?? '').includes(pin);
    if (!entered) await sleep(2000);
  }
  if (!entered) onDetail?.('连接码输入未能确认（页面未跳转），继续等待连接状态…');

  // —— 连接确认 ——
  onDetail?.('等待连接建立…');
  const confirm = await waitDcctConnected({
    hdc,
    boxSn,
    dutSn,
    dutIdentifiers,
    workspace,
    deadlineMs: Math.max(30000, Math.min(remaining(), 120000)),
    onDetail,
  });
  return confirm.connected
    ? { connected: true, reason: `dcct 配对完成，${confirm.reason}` }
    : { connected: false, reason: `配对步骤已执行（信任+连接码），但${confirm.reason}` };
}

/**
 * 连接确认：轮询盒子/被测设备两侧 dcct UI，确认配对连接真正建立后 DCTS 才开测。
 * 判定必须严格：设备条目要出现在「已连接设备」分区标题之下（标题与「可用设备」标题之间），
 * 不能用整页文本包含——第 2 页常驻「已连接设备」标题和「可用设备」候选，文本包含永远误报。
 */
function deviceInConnectedSection(nodes, identifiers) {
  const label = nodes.find((node) => node.text === '已连接设备');
  if (!label) return false;
  const nextLabel = nodes.find((node) => node.text === '可用设备' && node.y > label.y);
  return nodes.some((node) => identifiers.includes(node.text)
    && node.y > label.y
    && (nextLabel ? node.y < nextLabel.y : true));
}

/**
 * 解绑 dcct 上已有的全部「已连接设备」（用户要求 2026-11-25：DCTS 组网前先清空历史连接）。
 *
 * 走 `bm clean -n <dcct> -d` 清应用数据，而不是点界面上的「删除」：
 * 实测点「是否删除 <设备名>」→「删除」后弹窗关闭，但设备条目**依然留在已连接列表里**
 * （2026-11-25 盒子实测 12 次点击后仍是同一台）；bm clean 后重新拉起 dcct，列表为空。
 * 清完再核对一次界面，避免「清是清了、列表只是没刷新」的自欺。
 */
async function unbindDcctDevices(hdc, sn, swipeArgs, tag, onDetail) {
  /** 进到设备列表页并数「已连接设备」分区里的条目；不在列表页返回 null。 */
  const connectedCount = async () => {
    const nodes = await dumpUiNodes(hdc, sn);
    const label = nodes.find((node) => node.text === '已连接设备');
    if (!label) return null;
    const available = nodes.find((node) => node.text === '可用设备' && node.y > label.y);
    return nodes.filter((node) => node.text === '已连接'
      && node.y > label.y
      && (available ? node.y < available.y : true)).length;
  };

  /** 清数据会连授权一起清掉，dcct 会连弹多道系统授权（一道接一道），轮询放行到不再弹为止。 */
  const relaunchAndDismiss = async () => {
    await hdcCommand(hdc, ['-t', sn, 'shell', 'aa', 'start', '-b', DCCT_BUNDLE_NAME, '-a', DCCT_ABILITY_NAME], 10000).catch(() => {});
    await sleep(3000);
    for (let round = 0; round < 8; round += 1) {
      if (!await dismissDcctPermissionDialog(hdc, sn, onDetail)) break;
      await sleep(1200);
    }
  };

  // 必须先推进到设备列表页（dcct 冷启动停在第 1 页的组网方式选择），否则读不到分区。
  await wakeUnlockScreen(hdc, sn, swipeArgs, onDetail);
  await relaunchAndDismiss();
  const prep = await prepareDcctPage(hdc, sn, swipeArgs, tag, onDetail);
  if (!prep.ok) return { ok: false, removed: 0, reason: prep.reason };

  const before = await connectedCount();
  if (before === null) {
    return { ok: false, removed: 0, reason: `${tag}找不到「已连接设备」分区` };
  }
  if (before === 0) return { ok: true, removed: 0 };

  // 走 bm clean 而不是点界面「删除」：实测点「删除」后弹窗关闭但条目仍在列表里
  // （盒子连续 12 次点击仍是同一台）；bm clean 后重新拉起，列表为空。
  onDetail?.(`${tag}存在 ${before} 台历史连接，清空 dcct 数据…`);
  const clean = await hdcCommand(hdc, ['-t', sn, 'shell', 'bm', 'clean', '-n', DCCT_BUNDLE_NAME, '-d'], 20000).catch(() => undefined);
  if (!clean || clean.code !== 0) {
    return { ok: false, removed: 0, reason: `${tag}bm clean 执行失败：${String(clean?.stdout || clean?.stderr || '').trim().slice(0, 200)}` };
  }

  await relaunchAndDismiss();
  const prepAgain = await prepareDcctPage(hdc, sn, swipeArgs, tag, onDetail);
  if (!prepAgain.ok) return { ok: false, removed: 0, reason: prepAgain.reason };
  const after = await connectedCount();
  if (after !== 0) {
    return { ok: false, removed: 0, reason: `${tag}已执行 bm clean，但列表里仍有 ${after ?? '未知数量'} 台已连接设备` };
  }
  onDetail?.(`${tag}历史连接已清空（原 ${before} 台）`);
  return { ok: true, removed: before };
}

async function waitDcctConnected({ hdc, boxSn, dutSn, dutIdentifiers, workspace, deadlineMs, onDetail }) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const boxNodes = await dumpUiNodes(hdc, boxSn).catch(() => []);
    const dutNodes = await dumpUiNodes(hdc, dutSn).catch(() => []);
    const boxSeesDut = boxNodes.length > 0 && deviceInConnectedSection(boxNodes, dutIdentifiers);
    const dutSeesBox = dutNodes.length > 0 && deviceInConnectedSection(dutNodes, ['Bed Terminal']);
    if (boxSeesDut || dutSeesBox) {
      const reason = boxSeesDut
        ? `盒子 dcct「已连接设备」分区出现被测设备（${dutIdentifiers[0]}）`
        : '被测设备 dcct「已连接设备」分区出现盒子';
      return { connected: true, reason };
    }
    onDetail?.(`等待连接确认…剩余 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s`);
    await sleep(BOX_POLL_INTERVAL_MS);
  }
  return { connected: false, reason: '超时未确认连接（盒子/被测设备 dcct 的「已连接设备」分区均为空）' };
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

  // 预检通过即返回——softbus 框架自行处理设备发现与连接（历史配对已建立互信）。
  // dcct 配对自动化保留为可选加速能力，但不阻塞 DCTS 执行。
  return { connected: true, reason: `预检通过（盒子 ${boxIp} · 被测设备 ${dutIp} · 同网段 · ping ✓）` };
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
    const resolvedTestcases = await resolveSuiteRoot(String(args.testcases));
    const testcaseRoot = resolvedTestcases.root;
    if (resolvedTestcases.note) warnings.push(resolvedTestcases.note);
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
    const boxWaitMs = Math.max(30000, Math.floor(Number(args['box-wait-ms']) || 10 * 60 * 1000));

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
    // —— 增量模式：从各套件最新归档报告里提取「未通过」（失败 + 没跑完）模块 ——
    const onlyFailed = args['only-failed'] === true || args['only-failed'] === 'true';
    const failedInfoBySuite = new Map();
    if (onlyFailed) {
      for (const archiveSuite of new Set(plan.map((step) => (step.suite === 'hats-hdf' ? 'hats' : step.suite)))) {
        const archiveRoot = path.join(workbookRoot, 'report', suiteArchiveName(archiveSuite));
        const names = (await fs.readdir(archiveRoot).catch(() => []))
          .filter((name) => /^report-\d+$/.test(name))
          .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
        if (names.length === 0) continue; // 没有历史报告 → 该套件跑全量
        // 跨轮聚合：已通过 = 所有轮 result（tests>0）的并集——补测轮只含失败子集，
        // 只看最新轮会把历史轮通过的模块误判成"没跑完"。
        const passedUnion = new Set();
        for (const name of names) {
          for (const module of await finishedAndPassedModules(path.join(archiveRoot, name))) passedUnion.add(module);
        }
        const latest = path.join(archiveRoot, names[names.length - 1]);
        const summaryText = await fs.readFile(path.join(latest, 'summary_report.xml'), 'utf8').catch(() => '');
        const summary = summaryText ? parseSummaryReport(summaryText) : undefined;
        const failed = new Set((summary?.failedModules ?? []).map((module) => module.toLowerCase()));
        failedInfoBySuite.set(archiveSuite, { failed, passed: passedUnion, latest });
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
    // —— xdevice 自检（对应 run.bat 的第 1/3 步）——
    // 各套件 tools/ 里的 xdevice 是各自打包的（dcts/hats/acts 版才有新版报告模板与
    // _generate_test_report；ssts 版只有旧版 details/failures/passes_report.html）。
    // 所以不能只判断「能 import」，必须按套件核对版本指纹，跑的套件不匹配就重装成它自己的那份。
    if (!args['dry-run']) {
      for (const suite of new Set(plan.map((step) => (step.suite === 'hats-hdf' ? 'hats' : step.suite)))) {
        await ensureXdeviceReady({
          python,
          testcaseRoot,
          suite,
          onDetail: (detail) => emitProgress({ percent: 1, stage: '环境自检', detail }),
        });
      }
    }

    const listsDirectory = path.join(artifacts, 'lists');
    const reportsDirectory = path.join(artifacts, 'reports');
    await fs.mkdir(listsDirectory, { recursive: true });
    await fs.mkdir(reportsDirectory, { recursive: true });

    for (const step of plan) {
      let modules;
      if (overrideModules.length > 0) {
        // --modules 覆盖清单：同样要过 HATS 主轮/增量拆分（否则两步跑同一份清单，
        // 归档出内容重复的 report）。
        step.mode = 'list';
        delete step.minFile;
        modules = [...overrideModules];
      } else {
        if (step.mode !== 'list') continue;
        const file = path.join(minSetDir, step.minFile);
        if (!await isFile(file)) throw new TestFlowError(`缺少最小测试集清单：${file}`);
        modules = parseRunListLine(await fs.readFile(file, 'utf8'));
        if (modules.length === 0) throw new TestFlowError(`最小测试集清单为空：${file}`);
        // 增量模式：只跑最新报告里未通过的模块（失败 + 没跑完）；全部通过则跳过该步。
        if (onlyFailed) {
          const info = failedInfoBySuite.get(step.suite === 'hats-hdf' ? 'hats' : step.suite);
          if (info) {
            const notPassed = [];
            for (const module of modules) {
              const key = module.toLowerCase();
              if (!info.failed.has(key) && info.passed.has(key)) continue;
              if (!notPassed.includes(module)) notPassed.push(module);
            }
            if (notPassed.length === 0) { step.modules = []; step.skipReason = `最新报告（${path.basename(info.latest)}）全部通过，无需重跑`; continue; }
            modules = notPassed;
          }
        }
      }
      // HATS 主轮剔除 HDF 模块；HATS-HDF 增量轮只跑 HDF 模块。
      if (step.suite === 'hats' && screen === 'yes') {
        if (step.hdfOnly) {
          modules = filterHdfModules(modules);
          if (modules.length === 0) { step.modules = []; step.skipReason = '清单里没有 HDF 模块'; continue; }
        } else {
          modules = excludeHdfModules(modules);
          // 清单全是 HDF 模块时主轮为空——跳过主轮，只跑增量（用于单独补跑 HDF）。
          if (modules.length === 0) { step.modules = []; step.skipReason = '清单里没有非 HDF 的 HATS 模块，主轮跳过'; continue; }
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
        const reportRoot = path.join(reportsDirectory, `${stepReportTag(step)}-r1`);
        return {
          suite: step.suite,
          command: [python, '-m', 'xdevice', 'run',
            ...(step.mode === 'task'
              ? [step.suite]
              : ['-tf', path.join(listsDirectory, `${stepReportTag(step)}-r1.txt`)]),
            '-c', path.join(testcaseRoot, step.suite === 'hats-hdf' ? 'hats' : step.suite, 'config', 'user_config.dsh-auto.xml'),
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
    const stopFile = path.join(artifacts, 'STOP');
    const requestStop = async () => {
      stopped = true;
      if (currentChild?.pid) killTree(currentChild.pid);
      if (currentChild?.pid) await new Promise((resolve) => currentChild.once('close', resolve));
    };
    const onStopSignal = () => {
      // Windows 上宿主可能 taskkill /F 硬杀（SIGTERM 不会触发），所以配合 STOP 标记文件双通道；
      // 这里只标记 + 杀当前子进程，收尾（合成 summary、归档、emitResult）交给主流程正常走完。
      stopped = true;
      if (currentChild?.pid) killTree(currentChild.pid);
    };
    process.on('SIGTERM', onStopSignal);
    process.on('SIGINT', onStopSignal);

    for (let stepIndex = 0; stepIndex < plan.length; stepIndex += 1) {
      if (stopped) break;
      const step = plan[stepIndex];
      if (step.skipReason) {
        const message = `${step.hdfLabel || suiteArchiveName(step.suite)} 已跳过：${step.skipReason}`;
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
        skippedSuites.push({ suite: step.suite, reason: step.skipReason });
        continue;
      }
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
        if (stopped || (!stopped && await isFile(stopFile))) { stopped = true; break; }

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

        const reportRoot = path.join(reportsDirectory, `${stepReportTag(step)}-r${round}`);
        await fs.mkdir(reportRoot, { recursive: true });
        let listFile;
        if (useList) {
          listFile = path.join(listsDirectory, `${stepReportTag(step)}-r${round}.txt`);
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
              // 清掉 DUT 侧 dcct 的历史信任数据再拉起：只删盒子侧连接会留下单向信任
              // （DUT 记得盒子但盒子不记得 DUT），此时盒子再发起连接 DUT 既不弹信任窗也不自动接上。
              await hdcCommand(hdc, ['-t', suiteSns[0], 'shell', 'bm', 'clean', '-n', DCCT_BUNDLE_NAME, '-d'], 10000).catch(() => {});
              await hdcCommand(hdc, ['-t', suiteSns[0], 'shell', 'aa', 'start', '-b', DCCT_BUNDLE_NAME, '-a', DCCT_ABILITY_NAME], 10000).catch(() => {});
              emitTestProgress('DUT dcct 已重置并拉起', true);
              // bm clean 连授权一起清了——dcct 首次启动会连弹三道系统授权（多设备协同/定位/文件），
              // 在资源阶段就地放行，不留弹窗挡住后续的配置页推进与配对。
              await sleep(2500);
              await dismissDcctPermissionDialog(hdc, suiteSns[0], (detail) => emitTestProgress(detail, true));
              emitTestProgress('dcct 授权弹窗已放行', true);
              await sleep(3000);
            }
            emitTestProgress(`设备 ${suiteSns[0]} 已回线，开始 ${suiteArchiveName(step.suite)} 测试。`, true);
          }
        }

        // DCTS 前置：连通预检 → 重连/自动配对 → 连接确认；确认不了连接就跳过 DCTS（配对是 DCTS 的前提）。
        if (step.suite === 'dcts' && round === 1 && !boxPrecheckDone) {
          boxPrecheckDone = true;
          emitTestProgress('DCTS 前置：连通预检（在线 / 同网段 / ping）…', true);
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
          emitTestProgress(`DCTS 前置通过：${precheck.reason}`, true);

          // 组网前先解绑两端的历史连接（用户要求 2026-11-25）：盒子与 DUT 的 dcct「已连接设备」
          // 里残留旧机器时，盒子发现列表会混入历史条目、连接码会发给旧设备，配对必然失败。
          emitTestProgress('DCTS 组网前解绑历史连接（盒子 + 被测设备）…', true);
          const boxUnbind = await unbindDcctDevices(hdc, testBoxSn, ['400', '1100', '400', '300', '300'], '盒子', (detail) => emitTestProgress(detail, true));
          if (!boxUnbind.ok) {
            skipReason = `${boxUnbind.reason}；dcct 组网前必须先清空历史连接，请人工删除后重跑 DCTS`;
            break;
          }
          const dutUnbind = await unbindDcctDevices(hdc, suiteSns[0], ['500', '1200', '500', '300', '300'], '被测设备', (detail) => emitTestProgress(detail, true));
          if (!dutUnbind.ok) {
            skipReason = `${dutUnbind.reason}；dcct 组网前必须先清空历史连接，请人工删除后重跑 DCTS`;
            break;
          }
          emitTestProgress(`历史连接已清空（盒子 ${boxUnbind.removed} 台 / 被测设备 ${dutUnbind.removed} 台）`, true);

          const dutIdentifiers = [];
          for (const param of ['const.product.name', 'const.product.model', 'const.product.brand']) {
            const value = await deviceParam(hdc, suiteSns[0], param).catch(() => '');
            if (value && value.length >= 2 && !dutIdentifiers.includes(value)) dutIdentifiers.push(value);
          }

          // —— 配网：盒子 dcct 推进 + 自动配对（被测设备不启动 dcct）。
          // 用户要求「点开始测试就要完成连接」：配对失败自动整体重试（时限内最多 2 次）。
          emitTestProgress('执行 dcct 自动配对（盒子侧配置 → 发现 → 信任 → 连接码 → 连接确认）…', true);
          const pairingDeadline = Date.now() + boxWaitMs;
          let pairing = { connected: false, reason: '' };
          for (let pairingAttempt = 1; pairingAttempt <= 2; pairingAttempt += 1) {
            const left = pairingDeadline - Date.now();
            if (left <= 30000) break;
            if (pairingAttempt > 1) emitTestProgress(`第 ${pairingAttempt} 次尝试自动配对…`, true);
            pairing = await performDcctPairing({
              hdc,
              boxSn: testBoxSn,
              dutSn: suiteSns[0],
              dutIdentifiers,
              workspace: artifacts,
              deadlineMs: left,
              onDetail: (detail) => emitTestProgress(detail, true),
            });
            if (pairing.connected) break;
          }
          const confirmed = pairing.connected
            ? { connected: true, reason: pairing.reason }
            : { connected: false, reason: pairing.reason };

          // —— 连接确认失败 → 跳过 DCTS ——
          if (!confirmed.connected) {
            skipReason = `${confirmed.reason}；DCTS 测试的前提是盒子与被测设备完成 dcct 配对连接，可在盒子上人工完成配对后单独重跑 DCTS`;
            break;
          }
          emitTestProgress(`DCTS 配网完成：${confirmed.reason}`, true);
        }

        // 每轮把「实际命令 + 退出码 + stderr 尾巴」落到 <artifacts>/run.log：
        // 套件跑不起来时，用户手里就有可核对的一行，而不是只有一个「失败」。
        const runLogPath = path.join(artifacts, 'run.log');
        const appendRunLog = (line) => { fs.appendFile(runLogPath, `${new Date().toISOString()} ${line}\n`).catch(() => {}); };
        appendRunLog(`START ${step.suite} r${round}: ${python} ${commandArgs.join(' ')} (cwd=${suiteDir})`);
        emitTestProgress(`${describeRound()} 启动 · 命令 ${python} ${commandArgs.join(' ')}`);
        let stderrTail = '';
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
        child.stderr?.on('data', (chunk) => {
          lastActivity = Date.now();
          stderrTail = (stderrTail + chunk.toString()).slice(-4000);
        });
        child.once('close', (code) => appendRunLog(`EXIT ${step.suite} r${round}: code=${code} stderr=${stderrTail.replace(/\s+/g, ' ').slice(-500)}`));

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
          // 停止标记文件（Windows 宿主 taskkill /F 不触发 SIGTERM 的优雅停止通道）。
          if (await isFile(stopFile)) { await requestStop(); break; }
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
        let summaryPath = reportDirectory ? path.join(reportDirectory, 'summary_report.xml') : '';
        let summaryText = summaryPath ? await fs.readFile(summaryPath, 'utf8').catch(() => '') : '';
        // 停止或看门狗终止的轮次没有完整报告——用已完成模块的 result XML 合成全套产物（xml/html/static/ini/record）。
        // 看门狗轮次也必须合成：否则判卷走「缺少 summary」分支，未跑完的模块不会进补测（测试就断在半截）。
        if ((stopped || watchdogFired) && reportDirectory && !summaryText) {
          try {
            await writeSynthesizedReportFiles(reportDirectory, {
              suite: step.suite,
              command: describeRound(),
              sessionId: `${step.suite}-r${round}`,
              workbookRoot,
              logPath: reportDirectory,
            });
            summaryPath = path.join(reportDirectory, 'summary_report.xml');
            summaryText = await fs.readFile(summaryPath, 'utf8').catch(() => '');
          } catch (error) {
            warnings.push(`停止归档补全失败（不影响已有产物）：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const taskInfoPath = reportDirectory ? path.join(reportDirectory, 'task_info.record') : '';
        const taskInfoText = taskInfoPath ? await fs.readFile(taskInfoPath, 'utf8').catch(() => '') : '';
        const summary = summaryText ? parseSummaryReport(summaryText) : undefined;
        // 判卷以 summary 为准（failures>0 或整模块 ignored 都算失败）；
        // task_info.unsuccessful_params 会把"有 ignored 用例的通过模块"也列进来，只在
        // summary 完全缺失时兜底，避免把通过模块误送进补测。
        let failedModules = summary
          ? [...summary.failedModules]
          : (parseTaskInfoRecordText(taskInfoText) || []);
        // 跑了一半就挂（runmodules < 总数、又没记失败）→ 没跑完的模块全部进补测。
        if (summary && !summary.ok && failedModules.length === 0
          && Number.isFinite(summary.total) && Number.isFinite(summary.runModules)
          && summary.runModules < summary.total && useList) {
          const finishedNames = new Set(await finishedModuleNames(reportDirectory));
          failedModules = pendingModules.filter((module) => !finishedNames.has(module.toLowerCase()));
        }
        // 看门狗终止的轮次：失败模块 ∪ 没跑完的模块，一起进补测（测试从断点继续）。
        if (watchdogFired && useList) {
          const finishedNames = new Set(await finishedModuleNames(reportDirectory));
          for (const module of pendingModules) {
            if (!finishedNames.has(module.toLowerCase()) && !failedModules.includes(module)) failedModules.push(module);
          }
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

        const roundMessage = stopped
          ? `${suiteArchiveName(step.suite)} 第 ${round} 轮被停止，已完成 ${finishedCount} 模块${archivedTo ? `，已归档 ${archivedTo}` : ''}。`
          : watchdogFired
          ? `${suiteArchiveName(step.suite)} 第 ${round} 轮长时间无输出，已终止本轮。`
          : roundOk
            ? `${suiteArchiveName(step.suite)} 第 ${round} 轮全部通过${archivedTo ? `，已归档 ${archivedTo}` : ''}。`
            : `${suiteArchiveName(step.suite)} 第 ${round} 轮有 ${failedModules.length} 个失败模块${archivedTo ? `，已归档 ${archivedTo}` : ''}`
              + (!summary && stderrTail.trim() ? `；xdevice 输出：${stderrTail.replace(/\s+/g, ' ').trim().slice(-300)}` : '') + '。';
        emitRound({
          suite: step.suite,
          suiteIndex: stepIndex + 1,
          suiteTotal: plan.length,
          round,
          ok: roundOk,
          failedModules,
          stopped,
          unavailable: summary?.unavailable,
          archivedTo: archivedTo || undefined,
          message: roundMessage,
        });
        rounds.push({
          suite: step.suite,
          round,
          ok: roundOk,
          failedModules,
          stopped,
          archivedTo: archivedTo || undefined,
        });

        if (stopped) break;
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

    const ok = !stopped && unpassed.length === 0 && skippedSuites.length === 0;
    const skippedText = skippedSuites.length > 0
      ? `已跳过 ${skippedSuites.length} 个套件（${skippedSuites.map((item) => suiteArchiveName(item.suite))}：${skippedSuites.map((item) => item.reason).join('；')}）。`
      : '';
    const message = stopped
      ? `XTS 测试已停止：已完成 ${rounds.length} 轮，当前套件已完成模块的报告已归档到 ${path.join(workbookRoot, 'report')}；重新开始测试或用「增量模式」补跑未通过模块即可。${skippedText}`
      : ok
      ? `XTS 自动测试完成：${describePlan()}，${rounds.length} 轮全部通过，报告已归档到 ${path.join(workbookRoot, 'report')}。`
      : skippedSuites.length > 0 && unpassed.length === 0
        ? `XTS 自动测试结束：${skippedText}其余套件${rounds.some((round) => !round.skipped && round.ok) ? '已通过' : '结果见 rounds'}。可单独重跑被跳过的套件（如 --suites dcts）。`
        : `XTS 自动测试结束，还有 ${unpassed.length} 个失败模块（${unpassed.map((item) => `${suiteArchiveName(item.suite)} ${item.module}`).join('、')}），已达补测上限，请人工排查或走豁免。${skippedText}`;
    emitResult({
      ok,
      stopped,
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
