import { spawn } from 'node:child_process';
import process from 'node:process';
import {
  parseHdcScreenOutput,
  parseHdcTargets,
  parseIfconfigInet,
  parseSnsInput,
  sameSubnet,
} from './xts_test_logic.mjs';

/**
 * 设备连接与配网（被「设备连接」页调用的独立脚本）。
 *
 * 模式：
 *   --list  --busy "a;b"            列出 hdc 在线设备（SN/IP/类型/是否忙碌）
 *   --tconn <ip:port>               hdc tconn 网络连接（后续支持的 IP 直连方式）
 *   --tdisconnect <ip:port>         hdc tdisconnect
 *   --pair --box <SN|ip:port> --dut <sn> [--timeout-ms 300000]
 *                                   盒子连通预检 + 拉起 dcct + 等待配对成功
 *
 * 行协议：
 *   DEVICE_LIST_JSON={"ok":true,"devices":[…]}
 *   DEVICE_PAIR_PROGRESS 走 PHASE2_PROGRESS 行协议（复用宿主解析）
 *   DEVICE_PAIR_JSON={"ok":true,"message":"…","addressType":"usb|network"}
 *   DEVICE_TCONN_JSON={"ok":true,"message":"…"}
 *
 * 地址自动识别：含「.」或「:」→ 网络地址（hdc tconn / -t ip:port）；否则 → USB SN。
 */

const HDC_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 15000;
const UITEST_REMOTE = '/data/local/tmp/oh-dsh-boxui.json';

function detectAddressType(address) {
  const value = String(address ?? '').trim();
  if (!value) return 'unknown';
  return /[.:]/.test(value) ? 'network' : 'usb';
}

function runCommand(command, args, timeoutMs = HDC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { windowsHide: true });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, error });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr });
    });
  });
}

const hdc = process.env.OH_XTS_HDC || 'hdc';

async function hdcCommand(args, timeoutMs = HDC_TIMEOUT_MS) {
  const result = await runCommand(hdc, args, timeoutMs);
  if (result.error) {
    const reason = result.error.code === 'ENOENT'
      ? `找不到 hdc（${hdc}）。请确认 hdc 在 PATH 里，或用环境变量 OH_XTS_HDC 指定。`
      : `hdc 启动失败：${result.error.message}`;
    throw new Error(reason);
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitProgress(message) {
  // 复用 PHASE2_PROGRESS 行协议（percent/stage/detail），宿主 runScript 统一解析。
  console.log(`PHASE2_PROGRESS=${JSON.stringify({ percent: 40, stage: '配网中', detail: message })}`);
}

async function readWlanIp(target) {
  const result = await hdcCommand(['-t', target, 'shell', 'ifconfig', 'wlan0']).catch(() => undefined);
  return result && result.code === 0 ? parseIfconfigInet(result.stdout) : '';
}

async function deviceParam(target, param) {
  const result = await hdcCommand(['-t', target, 'shell', 'param', 'get', param]).catch(() => undefined);
  if (!result || result.code !== 0) return '';
  const lines = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.pop() || '';
  if (!last || /fail!|errNum/i.test(last) || /^Get parameter/i.test(last)) return '';
  return last;
}

async function dumpBoxLayout(target) {
  const dumped = await hdcCommand(['-t', target, 'shell', 'uitest', 'dumpLayout', '-p', UITEST_REMOTE]).catch(() => undefined);
  if (dumped && dumped.code === 0) {
    const content = await hdcCommand(['-t', target, 'shell', 'cat', UITEST_REMOTE], 10000).catch(() => undefined);
    if (content && content.code === 0 && content.stdout.trim()) return content.stdout;
  }
  const plain = await hdcCommand(['-t', target, 'shell', 'uitest', 'dumpLayout'], 15000).catch(() => undefined);
  return plain && plain.code === 0 ? plain.stdout : '';
}

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] || '' : '';
  };
  const mode = argv.includes('--list') ? 'list'
    : argv.includes('--pair') ? 'pair'
    : argv.includes('--tconn') ? 'tconn'
    : argv.includes('--tdisconnect') ? 'tdisconnect'
    : '';
  return {
    mode,
    busy: parseSnsInput(value('--busy')),
    box: value('--box'),
    dut: value('--dut'),
    address: value('--tconn') || value('--tdisconnect'),
    timeoutMs: Math.max(30000, Math.floor(Number(value('--timeout-ms')) || 5 * 60 * 1000)),
    artifacts: value('--artifacts'),
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options.mode) throw new Error('未指定模式（--list / --pair / --tconn / --tdisconnect）。');

    if (options.mode === 'list') {
      const targets = await hdcCommand(['list', 'targets']);
      const online = parseHdcTargets(targets.stdout);
      const busySet = new Set(options.busy.map((item) => item.toLowerCase()));
      const devices = [];
      for (const sn of online) {
        const base = { sn, type: detectAddressType(sn) === 'network' ? 'network' : 'usb', busy: busySet.has(sn.toLowerCase()) };
        try {
          const ip = await readWlanIp(sn);
          devices.push({ ...base, ...(ip ? { ip } : {}) });
        } catch {
          devices.push(base);
        }
      }
      console.log(`DEVICE_LIST_JSON=${JSON.stringify({ ok: true, devices })}`);
      return;
    }

    if (options.mode === 'tconn' || options.mode === 'tdisconnect') {
      const address = options.address;
      if (!address) throw new Error('没有提供网络地址（ip:port）。');
      const verb = options.mode === 'tconn' ? 'tconn' : 'tdisconnect';
      const result = await hdcCommand([verb, address]);
      const ok = result.code === 0;
      console.log(`DEVICE_TCONN_JSON=${JSON.stringify({ ok, message: ok ? `${verb} ${address} 成功。` : `${verb} ${address} 失败：${(result.stderr || result.stdout).trim().slice(0, 200)}` })}`);
      if (!ok) process.exitCode = 1;
      return;
    }

    if (options.mode === 'pair') {
      const boxAddr = options.box.trim();
      const dutSn = options.dut.trim();
      if (!boxAddr) throw new Error('没有填写测试盒子地址（SN 或 IP:Port）。');
      if (!dutSn) throw new Error('没有选择被测设备。');
      const addressType = detectAddressType(boxAddr);
      const deadline = Date.now() + options.timeoutMs;
      const startedAt = Date.now();

      const progress = (message) => emitProgress({ message: `${message}（剩余 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s）` });

      const identifiers = [];
      for (const param of ['const.product.name', 'const.product.model', 'const.product.marketname', 'const.product.marketName', 'const.product.brand']) {
        const value = await deviceParam(dutSn, param);
        if (value && value.length >= 2 && !identifiers.includes(value)) identifiers.push(value);
      }

      let dcctLaunched = false;
      let lastStatus = '';
      let boxIp = '';
      let dutIp = '';
      while (Date.now() - startedAt < deadline) {
        const targets = await hdcCommand(['list', 'targets']).catch(() => undefined);
        const online = targets ? parseHdcTargets(targets.stdout) : [];
        if (!online.includes(boxAddr) && !(addressType === 'network' && online.some((item) => item.includes(boxAddr)))) {
          if (addressType === 'network' && boxIp) {
            // 网络盒子掉线自动重连一次。
            await hdcCommand(['tconn', boxAddr]).catch(() => undefined);
            await sleep(2000);
          }
          lastStatus = '盒子不在线（请确认盒子已连接；盒子 SN 不是被测设备 SN）';
          progress(lastStatus);
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        const boxTarget = addressType === 'network' && !online.includes(boxAddr)
          ? (online.find((item) => item.includes(boxAddr)) || boxAddr)
          : boxAddr;
        boxIp = await readWlanIp(boxTarget);
        dutIp = await readWlanIp(dutSn);
        if (!boxIp || !dutIp) {
          lastStatus = `读不到 IP（盒子 ${boxIp || '?'} / 被测设备 ${dutIp || '?'}），请确认两台设备 Wi-Fi 已连接`;
          progress(lastStatus);
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        if (!sameSubnet(boxIp, dutIp)) {
          lastStatus = `不在同网段（盒子 ${boxIp} vs 被测设备 ${dutIp}），请把两台设备接到同一路由/热点`;
          progress(lastStatus);
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        const ping = await runCommand('ping', process.platform === 'win32' ? ['-n', '2', '-w', '1000', boxIp] : ['-c', '2', '-W', '1', boxIp]).catch(() => undefined);
        if (ping && ping.code !== 0) {
          lastStatus = `ping 盒子 ${boxIp} 不通（防火墙拦 ICMP 可忽略，继续等配对）`;
          progress(lastStatus);
        }
        if (!dcctLaunched) {
          const bundles = await hdcCommand(['-t', boxTarget, 'shell', 'bm', 'dump', '-a']).catch(() => undefined);
          if (bundles && bundles.code === 0 && bundles.stdout.includes('com.example.myapplication')) {
            dcctLaunched = true;
            await hdcCommand(['-t', boxTarget, 'shell', 'aa', 'start', '-b', 'com.example.myapplication', '-a', 'EntryAbility']).catch(() => undefined);
            progress('已在盒子上拉起 dcct 应用，请完成配对（勾 Wi-Fi → 允许被发现 → 点击目标设备 → 永远信任 → 输入 PIN）');
          } else {
            progress('盒子上未发现 dcct 应用，请人工安装/打开 dcct');
          }
        } else {
          const layout = await dumpBoxLayout(boxTarget).catch(() => '');
          if (layout && identifiers.some((item) => layout.includes(item))) {
            console.log(`DEVICE_PAIR_JSON=${JSON.stringify({ ok: true, message: `盒子 ↔ 被测设备已连接（${identifiers.join(' / ')}）`, addressType, boxIp, dutIp })}`);
            return;
          }
          lastStatus = `盒子 ${boxIp} 与被测设备 ${dutIp} 同网段，等待 dcct 界面出现被测设备（${identifiers.join(' / ')}）`;
          progress(lastStatus);
        }
        await sleep(POLL_INTERVAL_MS);
      }
      console.log(`DEVICE_PAIR_JSON=${JSON.stringify({ ok: false, error: `${Math.round(options.timeoutMs / 1000)}s 内未确认连接：${lastStatus}`, addressType })}`);
      process.exitCode = 1;
      return;
    }
  } catch (error) {
    console.log(`DEVICE_PAIR_JSON=${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}`);
    process.exitCode = 1;
  }
}

// 屏幕能力解析保留给上层探测复用（--list 暂不采集 screen，避免逐台 hidumper 拖慢）。
void parseHdcScreenOutput;

await main();
