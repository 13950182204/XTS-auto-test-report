/**
 * XTS 测试方案单元测试（node:test，无外部依赖）：
 * 覆盖 HATS 主轮 / HDF 增量轮的拆分、清单解析、以及两轮报告根目录不得冲突
 * （2026-11-23 回归：增量轮复用 hats-rN 导致判卷读到主轮旧报告「假通过」，
 *  实测 178 项只归档 175，HatsHdfInput* 三模块从未真正执行）。
 * 运行：npm run test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  excludeHdfModules,
  filterHdfModules,
  HDF_MODULES,
  parseRunListLine,
  stepReportTag,
  suitePlan,
} from '../scripts/xts_test_logic.mjs'

const MIN_SET_SAMPLE = [
  'run -l HatsAccept4Test;HatsOpenPosixTest;HatsHdfDisplayBufferMtTest;',
  'HatsHdfInputPassthroughAdditionalTest;HatsHdfInputPassthroughTest;HatsHdfInputTest;',
  'HatszHdfDisplayComposerUtTest;HatsWritevTest',
].join('\n')

test('parseRunListLine：剥 run -l 前缀、分号拆分、保序去重', () => {
  const modules = parseRunListLine(MIN_SET_SAMPLE)
  assert.equal(modules.length, 8)
  assert.equal(modules[0], 'HatsAccept4Test')
  assert.equal(modules.at(-1), 'HatsWritevTest')
})

test('HDF_MODULES 常量：恰好是三个 HatsHdfInput* 增量模块', () => {
  assert.deepEqual([...HDF_MODULES].sort(), [
    'HatsHdfInputPassthroughAdditionalTest',
    'HatsHdfInputPassthroughTest',
    'HatsHdfInputTest',
  ])
})

test('主轮 excludeHdfModules 剔除全部 HDF 模块', () => {
  const modules = parseRunListLine(MIN_SET_SAMPLE)
  const main = excludeHdfModules(modules)
  assert.equal(main.length, 5)
  for (const hdf of HDF_MODULES) assert.ok(!main.includes(hdf), `主轮不应包含 ${hdf}`)
})

test('增量 filterHdfModules 只取三个 HDF 模块', () => {
  const modules = parseRunListLine(MIN_SET_SAMPLE)
  assert.deepEqual(filterHdfModules(modules), [
    'HatsHdfInputPassthroughAdditionalTest',
    'HatsHdfInputPassthroughTest',
    'HatsHdfInputTest',
  ])
})

test('大小写不敏感：小写清单同样能拆分', () => {
  const lower = parseRunListLine(MIN_SET_SAMPLE).map((m) => m.toLowerCase())
  assert.equal(excludeHdfModules(lower).length, 5)
  assert.equal(filterHdfModules(lower).length, 3)
})

test('有屏方案：HATS 主轮 + HDF 增量两步，报告标签不同（回归核心）', () => {
  const plan = suitePlan('yes')
  const hatsSteps = plan.filter((step) => step.suite === 'hats')
  assert.equal(hatsSteps.length, 2, '有屏方案应有 HATS 主轮 + HDF 增量两步')
  assert.equal(hatsSteps[0].hdfOnly, undefined, '第一步是主轮（非 hdfOnly）')
  assert.equal(hatsSteps[1].hdfOnly, true, '第二步是 HDF 增量（hdfOnly）')
  const tags = new Set(hatsSteps.map((step) => stepReportTag(step)))
  assert.equal(tags.size, 2, `主轮与增量轮的报告标签必须不同（实际 ${[...tags].join(' / ')}）`)
  assert.equal(stepReportTag(hatsSteps[0]), 'hats')
  assert.equal(stepReportTag(hatsSteps[1]), 'hats-hdf')
})

test('无屏方案：只有 HATS 主轮，不产生 HDF 增量步', () => {
  const plan = suitePlan('no')
  const hatsSteps = plan.filter((step) => step.suite === 'hats')
  assert.equal(hatsSteps.length, 1)
  assert.equal(hatsSteps[0].hdfOnly, undefined)
})

test('stepReportTag：普通步骤就是套件名', () => {
  assert.equal(stepReportTag({ suite: 'acts' }), 'acts')
  assert.equal(stepReportTag({ suite: 'hats' }), 'hats')
  assert.equal(stepReportTag({ suite: 'hats', hdfOnly: true }), 'hats-hdf')
})
