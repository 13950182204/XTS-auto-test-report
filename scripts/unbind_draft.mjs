import {
  ensureWorkbookWritable,
  readPhase2Workbook,
  writeWorkbookState,
} from './phase2_logic.mjs';

/**
 * 草稿解除关联（纯本地操作，不登录平台）：清掉工作簿里记录的 申请标识 / 测评编号，
 * 让「未提交草稿」面板不再显示这条，下次「评测资料提交」重新建一条申请。
 * 平台上的旧申请记录**不会**被删除或修改。
 *
 * stdout 只有一行结果协议：
 *   PHASE2_UNBIND_JSON={"ok":true,"workbookPath":"…","message":"…"}
 */

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] || '' : '';
  };
  const workbook = value('--workbook');
  if (!workbook) throw new Error('没有提供工作簿路径（--workbook），已停止执行。');
  return {
    workbook,
    assessmentNumber: value('--assessment-number'),
    applicationId: value('--application-id'),
  };
}

function emit(result) {
  console.log(`PHASE2_UNBIND_JSON=${JSON.stringify(result)}`);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    // 工作簿可能正被 WPS/Excel 打开：先等写锁（复用既有重试逻辑），再读再写。
    await ensureWorkbookWritable(options.workbook);

    let current = null;
    let readable = true;
    try {
      current = (await readPhase2Workbook(options.workbook)).record;
    } catch (error) {
      // 废稿可能本身校验不过（正是要解除的那类）——读不动就跳过一致性校验，直接按请求清。
      readable = false;
      console.error(`工作簿校验未通过，按请求直接解除关联：${error instanceof Error ? error.message.split('；')[0] : String(error)}`);
    }
    if (readable && current) {
      const recordApplicationId = String(current.applicationId || '').trim();
      const recordAssessmentNumber = String(current.assessmentNumber || '').trim();
      if (!recordApplicationId && !recordAssessmentNumber) {
        emit({ ok: true, workbookPath: options.workbook, message: '这条草稿本来就没有平台关联，无需解除。' });
        return;
      }
      const wantedApplicationId = options.applicationId.trim();
      const wantedAssessmentNumber = options.assessmentNumber.trim();
      const matches = (wantedApplicationId && recordApplicationId === wantedApplicationId)
        || (wantedAssessmentNumber && recordAssessmentNumber === wantedAssessmentNumber);
      if (wantedApplicationId && !matches) {
        emit({
          ok: false,
          workbookPath: options.workbook,
          error: `工作簿当前记录（${recordAssessmentNumber || recordApplicationId}）与所选草稿不一致，请刷新草稿后重试。`,
        });
        process.exitCode = 1;
        return;
      }
    }

    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await writeWorkbookState(options.workbook, {
      status: '已解除关联',
      applicationId: '',
      assessmentNumber: '',
      processedAt: stamp,
      notes: `草稿关联已解除（${stamp}，人工确认）；平台上的旧申请记录未删除，下次「评测资料提交」将新建申请。`,
    });
    emit({
      ok: true,
      workbookPath: options.workbook,
      message: '已解除草稿关联（平台上的旧申请记录未删除）；下次「评测资料提交」将新建一条申请。',
    });
  } catch (error) {
    emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

await main();
