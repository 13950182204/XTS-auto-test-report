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
 * 设备探测（只读）：检查 SN 在线并逐台判定有屏/无屏；可选校验测试盒子。
 *
 * stdout 只有一行结果协议：
 *   XTS_PROBE_RESULT={"ok":true,"screen":"yes","devices":[…],"box":{"sn","online","ip","sameSubnet"},"message":"…"}
 * 探测不占测试互斥、不改设备状态；hdc 缺失或超时按 ok:false 返回中文原因。
 */

const HDC_TIMEOUT_MS = 15000;

function runCommand(command, args, timeoutMs = HDC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { windowsHide: true });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 进程已退出 */ }
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

async function main() {
  const snsArgumentIndex = process.argv.indexOf('--sns');
  const sns = parseSnsInput(snsArgumentIndex >= 0 ? process.argv[snsArgumentIndex + 1] : '');
  const hdc = process.env.OH_XTS_HDC || 'hdc';
  if (sns.length === 0) {
    console.log(`XTS_PROBE_RESULT=${JSON.stringify({ ok: false, screen: 'unknown', error: '没有提供设备 SN，无法探测。' })}`);
    process.exitCode = 1;
    return;
  }
  const targets = await runCommand(hdc, ['list', 'targets']);
  if (targets.error) {
    const reason = targets.error.code === 'ENOENT'
      ? `找不到 hdc（${hdc}）。请确认 hdc 在 PATH 里，或用环境变量 OH_XTS_HDC 指定。`
      : `hdc 启动失败：${targets.error.message}`;
    console.log(`XTS_PROBE_RESULT=${JSON.stringify({ ok: false, screen: 'unknown', error: reason })}`);
    process.exitCode = 1;
    return;
  }
  const online = parseHdcTargets(targets.stdout);
  const devices = [];
  for (const sn of sns) {
    if (!online.includes(sn)) {
      devices.push({ sn, online: false });
      continue;
    }
    const dump = await runCommand(hdc, ['-t', sn, 'shell', 'hidumper', '-s', 'RenderService', '-a', 'screen']);
    devices.push({
      sn,
      online: true,
      ...(dump.code === 0 ? { screen: parseHdcScreenOutput(dump.stdout) } : {}),
    });
  }
  const probed = devices.filter((device) => device.screen);
  const screens = [...new Set(probed.map((device) => device.screen))];
  const offline = devices.filter((device) => !device.online).map((device) => device.sn);
  const screen = probed.length === 0 ? 'unknown' : screens.length === 1 ? screens[0] : 'mixed';
  const screenText = screen === 'yes' ? '有屏' : screen === 'no' ? '无屏' : screen === 'mixed' ? '有屏与无屏混合' : '未知';
  const offlineText = offline.length > 0 ? `；离线：${offline.join('、')}` : '';

  // 测试盒子（可选）：在线状态 + 盒子 IP + 与第一台被测设备的同网段结果。
  let box;
  const boxSn = parseSnsInput(process.argv[process.argv.indexOf('--box-sn') + 1] || '')[0] || '';
  if (boxSn) {
    if (!online.includes(boxSn)) {
      box = { sn: boxSn, online: false, ip: '', sameSubnet: false };
    } else {
      const boxIfconfig = await runCommand(hdc, ['-t', boxSn, 'shell', 'ifconfig', 'wlan0']);
      const boxIp = boxIfconfig.code === 0 ? parseIfconfigInet(boxIfconfig.stdout) : '';
      const firstOnlineDut = devices.find((device) => device.online)?.sn || '';
      let dutIp = '';
      if (firstOnlineDut) {
        const dutIfconfig = await runCommand(hdc, ['-t', firstOnlineDut, 'shell', 'ifconfig', 'wlan0']);
        dutIp = dutIfconfig.code === 0 ? parseIfconfigInet(dutIfconfig.stdout) : '';
      }
      const same = boxIp && dutIp ? sameSubnet(boxIp, dutIp) : false;
      box = { sn: boxSn, online: true, ip: boxIp, sameSubnet: same };
    }
  }
  const boxText = box
    ? box.online
      ? `；测试盒子 ${box.ip || 'IP 未知'}${box.sameSubnet ? '（与被测设备同网段 ✓）' : '（与被测设备不同网段/读不到 IP ✗）'}`
      : '；测试盒子不在线（DCTS 会跳过）'
    : '';

  const message = `探测完成：${sns.length} 台设备，${screenText}${offlineText}${boxText}。`;
  console.log(`XTS_PROBE_RESULT=${JSON.stringify({ ok: true, screen, devices, ...(box ? { box } : {}), message })}`);
}

await main();
