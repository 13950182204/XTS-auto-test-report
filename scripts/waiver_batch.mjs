#!/usr/bin/env node
/**
 * 豁免资料批量处理：从指定路径（目录或单个 .txt）解析豁免报告，逐条调用
 * `waiver_draft.mjs` 保存草稿。只保存，不提交。
 *
 * 用法：
 *   node scripts/waiver_batch.mjs --input <目录或.txt> --assessment <测评编号> \
 *     [--dry-run|--save] [--artifacts <目录>]
 *   node scripts/waiver_batch.mjs --input <目录或.txt> --scan
 *
 * 测试套分类不再人工传入：按豁免资料目录结构（Acts / ActsValidator / Hats / Dcts / Ssts）
 * 自动识别，目录识别不到再看报告首部「测试报告：ACTS 全量报告 …」兜底。
 *
 * 输出协议（与第二阶段批量一致，设置卡片直接复用进度/逐项列表）：
 *   PHASE2_BATCH_INIT=<json>
 *   PHASE2_PROGRESS=<json>
 *   PHASE2_BATCH_ITEM_RESULT=<json>
 *   PHASE2_RESULT_JSON=<json>   （最后一行）
 * --scan 只解析、不联网、不要求 --assessment，末行输出（也是唯一的 JSON 行）：
 *   WAIVER_SCAN_JSON=<json>     （单行、可直接 JSON.parse；扫描失败也 exit 0）
 *
 * 凭据从环境变量 OH_USERNAME / OH_PASSWORD 继承（由 Host 从设置页注入），
 * 不落盘、不打印。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { detectTestCategory, submissionPathFor } from './waiver_logic.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'waiver_draft.mjs')
// 用例行的解析规则见下方 CASE_BODY_RE / CASE_BULLET_RE / CASE_LABEL_RE。
const RESULT_PREFIX = 'WAIVER_RESULT_JSON='

function parseArgs(argv) {
  const options = { dryRun: true, save: false, scan: false, input: '', assessment: '', artifacts: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少取值`)
      index += 1
      return value
    }
    if (argument === '--dry-run') {
      options.dryRun = true
      options.save = false
    } else if (argument === '--save') {
      options.dryRun = false
      options.save = true
    } else if (argument === '--scan') options.scan = true
    else if (argument === '--input') options.input = next()
    else if (argument === '--assessment') options.assessment = next()
    else if (argument === '--artifacts') options.artifacts = next()
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`未知参数：${argument}`)
  }
  if (!options.help && !options.input) throw new Error('缺少 --input')
  // 扫描只解析资料，不需要测评编号；保存/预检仍然必须人工提供。
  if (!options.help && !options.scan && !options.assessment.trim()) throw new Error('缺少 --assessment')
  return options
}

function stamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

/**
 * 非豁免报告的 .txt：佐证/备份目录里的摘录与说明。豁免资料根下常见
 * `_backup_20261120/…/<用例>-report.txt`、`豁免原因.txt`、`screenshots/` 这类文件，
 * 它们既没有用例行也没有豁免原因，被当成报告去建草稿只会刷出一堆假失败。
 */
const NON_REPORT_DIR_RE = /^(?:evidence|screenshots|backups?)$|^[_.]/i
const NON_REPORT_FILE_RE = /-report\.txt$/i

async function listReports(input) {
  const status = await fs.stat(input).catch(() => null)
  if (!status) throw new Error(`路径不存在：${input}`)
  if (status.isFile()) return [input]
  if (!status.isDirectory()) throw new Error(`路径既不是文件也不是目录：${input}`)
  const found = []
  const walk = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name)
      // evidence/ 放的是佐证日志，不是豁免报告；不要当成报告去创建草稿。
      if (entry.isDirectory()) {
        if (!NON_REPORT_DIR_RE.test(entry.name)) await walk(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt') && !NON_REPORT_FILE_RE.test(entry.name)) {
        found.push(full)
      }
    }
  }
  await walk(input)
  return found
}

/** 按路径排序（code unit 比较，跨机器稳定），保证扫描/批量的输出顺序固定。 */
function sortByPath(reports) {
  return [...reports].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

/** 扫描根：目录输入就是该目录；单文件输入取「识别到的分类目录的父目录」。 */
async function resolveScanRoot(inputPath) {
  const status = await fs.stat(inputPath).catch(() => null)
  if (!status) throw new Error(`路径不存在：${inputPath}`)
  if (status.isDirectory()) return inputPath
  const reportText = await readText(inputPath)
  const detected = detectTestCategory({ reportPath: inputPath, reportText })
  return detected.categoryDirectory ? path.dirname(detected.categoryDirectory) : path.dirname(inputPath)
}

function unknownCategoryMessage(reportPath) {
  return `无法识别测试套分类：${reportPath}（目录应为 Acts/ActsValidator/Hats/Dcts/Ssts，或报告首部含『测试报告：ACTS …』）`
}

/**
 * 单份报告的分类上下文：分类在解析前识别好再交给 parseReport；
 * submissionPath 由扫描根推导（不解析正文里「平台提交路径」那行模板占位符）。
 */
async function reportContext(reportPath, scanRoot) {
  const reportText = await readText(reportPath)
  const detected = detectTestCategory({ reportPath, rootPath: scanRoot, reportText })
  // 提交路径的基准是「分类目录的父目录」而不是参数里的扫描根：用户可能只从 Acts/ 子目录
  // 发起扫描，但平台要的永远是 Acts/<模块>/<套件>.txt 这种带分类的路径。
  const pathRoot = detected.categoryDirectory ? path.dirname(detected.categoryDirectory) : scanRoot
  return {
    testCategory: detected.testCategory,
    categoryFolder: detected.categoryFolder,
    submissionPath: submissionPathFor({ rootPath: pathRoot, reportPath }),
  }
}

function cleanText(lines) {
  return lines.map((line) => line.trim().replace(/^[-*]\s*/, '')).filter(Boolean).join(' ').trim()
}

function splitSections(lines) {
  const sections = {}
  let current = null
  for (const line of lines) {
    const match = /^\s*([123])\.\s+/.exec(line)
    if (match) {
      current = Number(match[1])
      sections[current] = []
      continue
    }
    if (current !== null) sections[current].push(line)
  }
  return sections
}

const TRAILING_NOTE_RE = /[（(][^（）()]*[)）]\s*$/
const EVIDENCE_RE = /^-\s+(evidence\/[^\s：:]+)/
const ZIP_SUFFIX = '-豁免材料.zip'
const PDF_SUFFIX = '-豁免材料.pdf'
/** 用例行正文（去掉列表符号与「失败用例：」标签后的纯 `模块#套件#用例`）。 */
const CASE_BODY_RE = /^([A-Za-z0-9_]+)#([A-Za-z0-9_]+)#(.+?)\s*$/
/** 用例行的两种前缀：列表符号 `- ` / `* `，以及中文标签「失败用例：」（HATS 与部分 ACTS 报告用）。 */
const CASE_BULLET_RE = /^[-*]\s*/
const CASE_LABEL_RE = /^(?:失败用例|用例)\s*[：:]\s*/
/**
 * 模块级豁免声明：`模块级豁免：<模块名> 全部用例（…）`。
 * HATS（HDF 输入）这类「被测对象在本机型不存在」的模块，平台侧的豁免语义就是模块级
 * ——不填测试套、不填用例名。此前只认用例行，导致这类报告一律被判「没有失败用例」。
 */
const MODULE_SCOPE_RE = /模块级豁免\s*[：:]\s*([A-Za-z0-9_]+)/

function parseCases(lines) {
  const cases = []
  for (const line of lines) {
    // 三种写法都要认：`- M#S#C`、`M#S#C`、`失败用例：M#S#C`。
    const body = line.trim().replace(CASE_BULLET_RE, '').replace(CASE_LABEL_RE, '')
    const match = CASE_BODY_RE.exec(body)
    if (!match) continue
    // 用例行允许「（报告耗时 x s）」尾注；提交给平台的 Testcase 只要裸用例名。
    const testcase = match[3].replace(TRAILING_NOTE_RE, '').trim()
    cases.push({ module: match[1], testsuite: match[2], testcase })
  }
  return cases
}

function referencedEvidence(lines) {
  const refs = []
  for (const line of lines) {
    const match = EVIDENCE_RE.exec(line.trim())
    if (match && !refs.includes(match[1])) refs.push(match[1])
  }
  return refs
}

/**
 * 豁免资料布局校验（与闭环插件 scripts/verify_waiver_layout.py 同一套规则）：
 * 一个模块的一个 Testsuite = 一个 <套件>.txt + 一个 <套件>-豁免材料.zip。
 */
async function checkLayout(reportPath, moduleName, testsuite, evidenceRefs) {
  const problems = []
  const directory = path.dirname(reportPath)
  const expectedName = `${testsuite}.txt`
  if (path.basename(reportPath) !== expectedName) {
    problems.push(`文件名应为 ${expectedName}（当前 ${path.basename(reportPath)}）`)
  }
  // 两种都是合法布局：<分类>/<模块>/<套件>.txt（Acts）与
  // <分类>/<套件>/<套件>.txt（ActsValidator，用例第一段是分类名、目录名等于套件名）。
  const directoryName = path.basename(directory)
  if (directoryName !== moduleName && directoryName !== testsuite) {
    problems.push(`父目录应为模块名或套件名 ${moduleName}/${testsuite}（当前 ${directoryName}）`)
  }
  const archive = path.join(directory, `${testsuite}${ZIP_SUFFIX}`)
  const archiveStat = await fs.stat(archive).catch(() => null)
  const hasArchive = archiveStat?.isFile() === true
  // 附件优先级（2026-11-22 用户要求）：① <套件>-豁免材料.zip
  // ② 豁免材料 PDF（<套件>-豁免材料.pdf 或 <套件>.pdf）③ 都没有才用本份报告 .txt。
  const pdfCandidates = [
    path.join(directory, `${testsuite}${PDF_SUFFIX}`),
    path.join(directory, `${testsuite}.pdf`),
  ]
  let pdfStat = null
  for (const candidate of pdfCandidates) {
    pdfStat = await fs.stat(candidate).catch(() => null)
    if (pdfStat?.isFile() === true) { pdfStat = { stat: pdfStat, file: candidate }; break }
    pdfStat = null
  }
  const attachmentPath = hasArchive ? archive : pdfStat ? pdfStat.file : path.resolve(reportPath)
  const attachmentKind = hasArchive ? 'zip' : pdfStat ? 'pdf' : 'txt'
  for (const ref of evidenceRefs) {
    const target = path.join(directory, ref)
    const stat = await fs.stat(target).catch(() => null)
    if (!stat?.isFile()) problems.push(`佐证文件不存在：${ref}`)
  }
  return { problems, attachmentPath, attachmentKind, archive, archiveStat }
}

/**
 * 解析一份豁免报告，但把「解析问题」与「布局问题」分开收集而不是直接抛：
 * 扫描模式要把它们收进 items[].problems[]（设置页要能预览这份资料哪里不对）；
 * 批量模式仍由 parseReport 抛出并中止。
 */
async function inspectReport(reportPath, assessment, testCategory) {
  const text = await fs.readFile(reportPath, 'utf8')
  const lines = text.split(/\r?\n/)
  const sections = splitSections(lines)
  const cases = parseCases(sections[1] ?? [])
  const parseProblems = []
  // 模块级豁免：声明了「模块级豁免：<模块> 全部用例」就不需要用例行（平台语义＝模块名有值、
  // 测试套与用例留空＝整个模块豁免）。模块名只认声明行与文件名，不从正文猜。
  const declaredModule = MODULE_SCOPE_RE.exec(text)?.[1] ?? ''
  const scope = cases.length > 0 ? 'cases' : declaredModule ? 'module' : ''
  if (scope === '') {
    parseProblems.push(`报告里没有失败用例：${reportPath}（需「- 模块#套件#用例」或「失败用例：模块#套件#用例」形式的用例行，或一行「模块级豁免：<模块名> 全部用例」）`)
  }
  const first = cases[0] ?? { module: '', testsuite: '' }
  if (cases.some((item) => item.module !== first.module || item.testsuite !== first.testsuite)) {
    parseProblems.push(`同一报告里混有不同模块/测试套：${reportPath}（一个 .txt 只能是一个模块的一个 Testsuite，请拆分文件）`)
  }
  const moduleName = first.module || declaredModule
  // 模块级豁免没有测试套：布局与附件仍按 <模块>.txt / <模块>-豁免材料.zip 这套命名校验，
  // 所以这里把「套件」位填成模块名，附件优先级（zip → pdf → txt）才不会失效。
  const testsuite = first.testsuite || (scope === 'module' ? moduleName : '')
  // 第 3 节只是「附件说明：xxx.docx」时不能当豁免理由提交（HATS 报告就是这种写法），
  // 真正的理由在第 2 节；两节都带上，避免平台「豁免原因」里只有一句附件索引。
  const secondReason = cleanText(sections[2] ?? [])
  const thirdReason = cleanText(sections[3] ?? [])
  const thirdIsIndex = /^附件(说明|索引)/.test(thirdReason) && thirdReason.length < 200
  const reason = thirdIsIndex
    ? [secondReason, thirdReason].filter(Boolean).join('\n\n')
    : thirdReason || secondReason
  if (!reason) parseProblems.push(`报告缺少豁免原因：${reportPath}`)
  const evidenceRefs = referencedEvidence(sections[1] ?? [])
  const layout = moduleName && testsuite
    ? await checkLayout(reportPath, moduleName, testsuite, evidenceRefs)
    : { problems: [], attachmentPath: path.resolve(reportPath), attachmentKind: 'txt' }
  return {
    record: {
      assessmentNumber: assessment,
      testCategory,
      scope,
      moduleName,
      testsuite: first.testsuite,
      testcases: cases.map((item) => item.testcase),
      caseCount: cases.length,
      waiverReason: reason,
      attachmentPath: layout.attachmentPath,
      attachmentKind: layout.attachmentKind,
      evidenceRelative: evidenceRefs,
      sourceReport: path.resolve(reportPath),
    },
    parseProblems,
    layoutProblems: layout.problems,
  }
}

/**
 * 单个 .txt → 一条记录；与 process_directory.py 的解析规则一致。
 * 分类必须已由调用方识别好传入（不再读 `--test-category`）。
 */
async function parseReport(reportPath, assessment, testCategory) {
  const { record, parseProblems, layoutProblems } = await inspectReport(reportPath, assessment, testCategory)
  if (parseProblems.length > 0) throw new Error(parseProblems[0])
  if (layoutProblems.length > 0) {
    throw new Error(`豁免资料布局不符合规范：${layoutProblems.join('；')}（${reportPath}）`)
  }
  return record
}

function scanItemFor(reportPath) {
  return {
    sourceReport: path.resolve(reportPath),
    categoryFolder: '',
    testCategory: '',
    moduleName: '',
    testsuite: '',
    caseCount: 0,
    testcases: [],
    attachmentPath: '',
    attachmentKind: 'txt',
    evidenceRelative: [],
    submissionPath: '',
    ready: false,
    problems: [],
  }
}

/** --scan：逐份报告输出结构性信息；识别/解析/布局问题都收进 problems[]，不抛错。 */
async function scanReports(reports, { scanRoot, assessment }) {
  const items = []
  for (const reportPath of reports) {
    const item = scanItemFor(reportPath)
    const context = await reportContext(reportPath, scanRoot)
    item.categoryFolder = context.categoryFolder
    item.testCategory = context.testCategory
    item.submissionPath = context.submissionPath
    if (!context.testCategory) item.problems.push(unknownCategoryMessage(reportPath))
    try {
      const inspection = await inspectReport(reportPath, assessment, context.testCategory)
      item.moduleName = inspection.record.moduleName
      item.testsuite = inspection.record.testsuite
      item.caseCount = inspection.record.caseCount
      item.testcases = inspection.record.testcases
      item.attachmentPath = inspection.record.attachmentPath
      item.attachmentKind = inspection.record.attachmentKind
      item.evidenceRelative = inspection.record.evidenceRelative
      item.problems.push(...inspection.parseProblems, ...inspection.layoutProblems)
    } catch (error) {
      item.problems.push(String(error && error.message ? error.message : error))
    }
    item.ready = item.testCategory !== '' && item.problems.length === 0
    items.push(item)
  }
  return items
}

function scanSummary(items) {
  const byCategory = {}
  for (const item of items) {
    if (!item.testCategory) continue
    byCategory[item.testCategory] = (byCategory[item.testCategory] ?? 0) + 1
  }
  const ready = items.filter((item) => item.ready).length
  return { total: items.length, ready, blocked: items.length - ready, byCategory }
}

function parseChildResult(output) {
  const lines = output.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith(RESULT_PREFIX)) continue
    try {
      const parsed = JSON.parse(line.slice(RESULT_PREFIX.length))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // 继续向前找
    }
  }
  return undefined
}

async function runOne(record, itemDir, options, onChildProgress) {
  const inputFile = path.join(itemDir, 'input.json')
  await fs.writeFile(inputFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  const args = [SCRIPT, '--input', inputFile, options.dryRun ? '--dry-run' : '--save', '--artifacts', itemDir]
  // 异步 spawn 并逐行转发子进程的 PHASE2_PROGRESS——浏览器保存一条草稿要 1~3 分钟，
  // spawnSync 会让批次进度整段时间静止（UI 看起来「卡住」）。
  const outcome = await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(process.execPath, args, { env: process.env, windowsHide: true })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 进程已退出 */ }
    }, 10 * 60 * 1000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith('PHASE2_PROGRESS=')) continue
        try {
          const parsed = JSON.parse(line.slice('PHASE2_PROGRESS='.length))
          if (parsed && typeof parsed === 'object') onChildProgress?.(parsed)
        } catch { /* 半行进度忽略 */ }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: 1, output: `${stdout}\n${String(error)}`.trim() })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, output: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim() })
    })
  })
  return { code: outcome.code, output: outcome.output, result: parseChildResult(outcome.output) }
}

function emit(line, value) {
  process.stdout.write(`${line}=${JSON.stringify(value)}\n`)
}

/**
 * 这台设备资料用的测评编号：取同目录下工具自己写的批量结果目录里的 result.json
 * （`OpenHarmony兼容性批量结果_<时间戳>/` 或 `OpenHarmony兼容性申请_第二阶段_结果_<时间戳>/`）。
 * 找不到就不拦（没有证据不乱判），找到但和参数不一致必须停。
 */
async function expectedAssessmentFor(inputPath) {
  let directory = path.dirname(path.resolve(inputPath))
  for (let depth = 0; depth < 3; depth += 1) {
    const entries = await fs.readdir(directory).catch(() => null)
    if (entries) {
      const hits = entries
        .filter((name) => name.startsWith('OpenHarmony兼容性批量结果_') || /^OpenHarmony兼容性申请_第二阶段_结果_/.test(name))
        .sort()
        .reverse()
      for (const hit of hits) {
        const source = path.join(directory, hit, 'result.json')
        const raw = await readText(source)
        if (!raw) continue
        try {
          const parsed = JSON.parse(raw)
          const number = parsed?.items?.[0]?.assessmentNumber || parsed?.assessmentNumber || ''
          if (String(number).trim()) return { number: String(number).trim(), source }
        } catch { /* 结果文件坏了就不据此拦截 */ }
      }
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

/**
 * --scan：只解析不联网；参数错误由 parseArgs 以退出码 2 结束，其余情况一律 exit 0。
 * `WAIVER_SCAN_JSON=` 必须是最后一行、单行、可直接 JSON.parse（items 按路径排序）。
 */
async function scanMode(options) {
  const inputPath = path.resolve(options.input)
  try {
    const scanRoot = await resolveScanRoot(inputPath)
    const reports = sortByPath(await listReports(inputPath))
    const items = await scanReports(reports, { scanRoot, assessment: options.assessment.trim() })
    emit('WAIVER_SCAN_JSON', { ok: true, root: scanRoot, items, summary: scanSummary(items) })
  } catch (error) {
    // 扫描是设置页的预览：任何读取/解析异常都转成 ok:false 的单行 JSON，进程仍 exit 0。
    emit('WAIVER_SCAN_JSON', {
      ok: false,
      root: inputPath,
      items: [],
      summary: { total: 0, ready: 0, blocked: 0, byCategory: {} },
      error: String(error && error.message ? error.message : error),
    })
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(String(error && error.message ? error.message : error))
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log('node scripts/waiver_batch.mjs --input <目录或.txt> --assessment <测评编号> [--dry-run|--save] [--artifacts <目录>]')
    console.log('node scripts/waiver_batch.mjs --input <目录或.txt> --scan')
    return
  }
  if (options.scan) {
    await scanMode(options)
    return
  }
  const artifactsRoot = options.artifacts
    ? path.resolve(options.artifacts)
    : path.join(os.tmpdir(), `oh-waiver-batch-${stamp()}`)
  await fs.mkdir(artifactsRoot, { recursive: true })

  const inputPath = path.resolve(options.input)
  let scanRoot
  let reports
  try {
    scanRoot = await resolveScanRoot(inputPath)
    reports = sortByPath(await listReports(inputPath))
  } catch (error) {
    console.error(`读取豁免资料失败：${error.message}`)
    process.exitCode = 1
    return
  }
  if (reports.length === 0) {
    console.error(`目录里没有 .txt 豁免报告：${options.input}`)
    process.exitCode = 1
    return
  }

  // 测评编号必须是这台设备的：草稿会挂到编号所在的认证记录下，错了就是挂到别的设备上，
  // 事后只能人工一条条删（2026-11-24 实测：拿 BC-HL4 的资料 + BM-HL4 的编号，12 条全挂错）。
  const expected = await expectedAssessmentFor(inputPath)
  if (expected && expected.number.toLowerCase() !== options.assessment.trim().toLowerCase()) {
    console.error(
      `测评编号与设备资料不一致，已停止：参数是 ${options.assessment.trim()}，`
      + `但 ${expected.source} 记录这台设备用的是 ${expected.number}。`
      + '请改正编号（或确认资料目录）后重跑；已生成的草稿请在平台按编号核对清理。',
    )
    process.exitCode = 1
    return
  }

  const items = reports.map((report, index) => ({
    directory: artifactsRoot,
    workbookPath: report,
    name: path.basename(report, '.txt'),
    taskIndex: index + 1,
    status: 'pending',
    percent: 0,
    stage: '待处理',
    detail: report,
  }))
  const results = []
  emit('PHASE2_BATCH_INIT', {
    mode: 'batch',
    kind: 'waiver',
    rootPath: inputPath,
    taskCount: items.length,
    skippedCount: 0,
    items,
  })
  emit('PHASE2_PROGRESS', {
    percent: 1,
    stage: '解析豁免资料',
    detail: `共 ${items.length} 份 .txt 报告`,
    itemIndex: 0,
    itemTotal: items.length,
    itemPercent: 0,
  })

  let failed = 0
  // 只有浏览器侧（已在平台留下状态）的失败才值得停整个批次；本地解析/布局失败不中断。
  let browserFailed = 0
  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index]
    const item = items[index]
    const itemDir = path.join(artifactsRoot, String(index + 1).padStart(3, '0'))
    await fs.mkdir(itemDir, { recursive: true })
    item.percent = 5
    item.stage = '解析报告'

    // 分类逐条识别：先算好 testCategory / submissionPath，再解析正文。
    const context = await reportContext(report, scanRoot)
    item.testCategory = context.testCategory
    item.submissionPath = context.submissionPath
    emit('PHASE2_BATCH_ITEM_RESULT', { ...item, percent: 5 })

    if (!context.testCategory) {
      item.status = 'blocked'
      item.percent = 100
      item.stage = '解析失败'
      item.detail = unknownCategoryMessage(report)
      failed += 1
      emit('PHASE2_BATCH_ITEM_RESULT', { ...item })
      results.push({ ...item, code: 'REPORT_PARSE_FAILED', message: item.detail })
      // 本地解析失败还没有碰过浏览器，不能连累后面的报告；继续跑完整个目录再统一汇总。
      continue
    }

    let record
    try {
      record = await parseReport(report, options.assessment.trim(), context.testCategory)
      record.submissionPath = context.submissionPath
    } catch (error) {
      item.status = 'blocked'
      item.percent = 100
      item.stage = '解析失败'
      item.detail = String(error.message)
      failed += 1
      emit('PHASE2_BATCH_ITEM_RESULT', { ...item })
      results.push({ ...item, code: 'REPORT_PARSE_FAILED', message: item.detail })
      continue
    }
    // 模块级豁免没有测试套：名字只显示模块名，别拼出一个尾巴是 '#' 的条目。
    item.name = record.testsuite ? `${record.moduleName}#${record.testsuite}` : `${record.moduleName}（整模块）`
    item.scope = record.scope
    item.assessmentNumber = record.assessmentNumber
    item.percent = 20
    item.stage = options.dryRun ? '登录并预检' : '登录并保存草稿'
    emit('PHASE2_BATCH_ITEM_RESULT', { ...item })
    emit('PHASE2_PROGRESS', {
      percent: Math.max(1, Math.round((index / reports.length) * 100)),
      stage: `第 ${index + 1}/${reports.length} 条：${item.stage}`,
      detail: `${item.name}（${record.testcases.length} 条用例）`,
      itemIndex: index + 1,
      itemTotal: reports.length,
      itemPercent: 20,
      workbookPath: report,
    })

    const outcome = await runOne(record, itemDir, options, (childProgress) => {
      // 子进程进度（0-100）映射到本条目的 20-100 区间；实时同步给宿主的批次进度。
      const childPercent = Math.max(0, Math.min(100, Number(childProgress.percent) || 0))
      item.percent = 20 + Math.round(childPercent * 0.8)
      if (childProgress.stage) item.stage = childProgress.stage
      if (childProgress.detail) item.detail = childProgress.detail
      emit('PHASE2_BATCH_ITEM_RESULT', { ...item })
      emit('PHASE2_PROGRESS', {
        percent: Math.max(1, Math.round(((index * 100 + item.percent) / reports.length))),
        stage: `${index + 1}/${reports.length} 条：${item.stage}`,
        detail: `${item.name}：${item.detail || ''}`,
        itemIndex: index + 1,
        itemTotal: reports.length,
        itemPercent: item.percent,
        workbookPath: report,
      })
    })
    const result = outcome.result ?? {}
    const derived = result.derived && typeof result.derived === 'object' ? result.derived : {}
    item.percent = 100
    if (outcome.code === 0 && (result.status === 'saved' || result.status === 'preflight-complete')) {
      item.status = result.status === 'saved' ? 'saved' : 'preflight'
      item.stage = result.status === 'saved' ? '已保存草稿' : '预检通过'
      item.detail = [derived.systemTypeName, derived.systemVersionName].filter(Boolean).join(' / ')
      if (result.status === 'saved') {
        item.message = result.message
      }
    } else if (result.status === 'stopped' && ['PENDING_DUPLICATE_FOUND', 'EXISTING_WAIVER_UNDER_REVIEW', 'EXISTING_WAIVER_APPROVED'].includes(result.code)) {
      item.status = 'skipped'
      item.stage = '已存在同键记录，跳过'
      item.detail = `${result.code}: ${result.message || ''}`
    } else {
      item.status = 'blocked'
      item.stage = '失败'
      item.detail = `${result.code || 'UNKNOWN'}: ${result.message || outcome.output.slice(-500)}`
      failed += 1
      browserFailed += 1
    }
    results.push({ ...item, code: result.code, message: result.message, artifacts: result.artifacts })
    emit('PHASE2_BATCH_ITEM_RESULT', { ...item, percent: 100, stage: item.stage, detail: item.detail })
    emit('PHASE2_PROGRESS', {
      percent: Math.max(1, Math.round(((index + 1) / reports.length) * 100)),
      stage: item.stage,
      detail: `${item.name}：${item.detail || ''}`,
      itemIndex: index + 1,
      itemTotal: reports.length,
      itemPercent: 100,
      workbookPath: report,
    })
    if (browserFailed > 0) break
  }

  // 被前序浏览器侧失败挡住的条目不能继续显示 0%「待处理」——那看起来像还在跑。
  for (const item of items) {
    if (item.status !== 'pending') continue
    item.status = 'skipped'
    item.stage = '未执行'
    item.detail = '前一条在浏览器侧失败已停止批次（本地解析失败不会中断）'
    emit('PHASE2_BATCH_ITEM_RESULT', { ...item })
  }

  const summary = {
    ok: failed === 0,
    status: failed > 0 ? 'blocked' : (options.dryRun ? 'preflight-complete' : 'saved'),
    kind: 'waiver',
    mode: 'batch',
    action: options.dryRun ? 'none' : 'save-draft',
    assessmentNumber: options.assessment.trim(),
    artifacts: artifactsRoot,
    items: items.map((item) => ({ ...item })),
    results,
    message: failed > 0
      ? '批量豁免草稿处理已停止：出现失败项，未继续创建后续草稿，也未提交任何申请。'
      : (options.dryRun
        ? '豁免资料预检完成：未创建草稿、未提交。'
        : '豁免草稿已保存（未提交；最终提交必须人工完成）。'),
  }
  emit('PHASE2_RESULT_JSON', summary)
  if (failed > 0) process.exitCode = 1
}

await main()
