// 每次换班后运行的准备度分析 CLI
// 用法：node tools/readiness-report.mjs [--day 9] [--json]
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { checkMaterials, parseTable } from './check-materials.mjs';
import { analyze, toNumber } from './readiness-engine.mjs';

const folder = new URL('../fixtures/', import.meta.url);

async function loadRawTables(source = folder) {
  const format = JSON.parse(await readFile(new URL('format.json', source), 'utf8'));
  const tables = {};
  for (const [name, fields] of Object.entries(format.tables)) {
    const content = await readFile(new URL(`${name}.csv`, source), 'utf8');
    tables[name] = parseTable(content, fields, name);
  }
  return tables;
}

function parseArgs(argv) {
  const args = { day: null, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--day') args.day = toNumber(argv[i + 1]);
    if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function renderText(report) {
  const lines = [];
  lines.push(`================ 志愿班组准备度分析（时点：第 ${report.metadata.asOfDay} 天）================`);
  lines.push('');

  lines.push('一、按岗位的人员准备度（未独立当班者给出剩余不确定性）');
  for (const r of report.readiness) {
    const stateLabel = {
      'solo-ready': '独立就绪',
      'supervised-only': '仅有监督证据',
      'insufficient-evidence': '证据不足',
      'not-credentialed': '未持证',
      'evidence-failure': '存在失败记录',
    }[r.state];
    const cert = r.credentialed
      ? '持证'
      : (r.reasons.some(x => x.startsWith('凭据有效期')) ? '凭据未生效' : '无凭据');
    const unc = r.uncertainty === null ? '-' : r.uncertainty;
    lines.push(
      `  ${r.person} @ ${r.venue}/${r.skill}  [${stateLabel}|${cert}]  ` +
      `solo通过=${r.profile.soloPass + r.profile.assessmentPass} ` +
      `solo失败=${r.profile.soloFail + r.profile.assessmentFail} ` +
      `监督=${r.profile.supervisedPass}过/${r.profile.supervisedFail}败 ` +
      `取消=${r.profile.cancelled} 缺考=${r.profile.noShow} ` +
      `pSolo=${r.estimate.pSolo} 不确定性=${unc}`,
    );
    for (const reason of r.reasons) lines.push(`      └ ${reason}`);
  }
  lines.push('');

  lines.push('二、排班缺口（主岗/替补/交接/跨馆冲突）');
  for (const check of report.shiftChecks.perShift) {
    const lock = check.locked ? '（已锁定，仅复核建议）' : '';
    if (check.findings.length === 0) {
      lines.push(`  ${check.shift}${lock}: 无缺口`);
    } else {
      lines.push(`  ${check.shift}${lock}:`);
      for (const f of check.findings) {
        const cat = { 'qualification-gap': '资格缺口', 'coverage-gap': '覆盖不足', 'evidence-gap': '证据不足' }[f.category];
        lines.push(`      [${cat}] ${f.code}: ${f.detail}`);
      }
    }
  }
  lines.push('  跨班次/跨馆冲突:');
  for (const c of report.shiftChecks.crossConflicts) {
    lines.push(`      [${c.kind}] ${c.detail}`);
  }
  lines.push('  交接重叠:');
  for (const h of report.shiftChecks.handovers) {
    let travelText = '';
    if (h.travel) {
      travelText = h.travel.overlapping
        ? '；跨馆：两班重叠，物理上不可兼顾'
        : `；跨馆间隔 ${h.travel.gap}/${h.travel.required} 分钟 ${h.travel.met ? '满足' : '不满足'}`;
    }
    lines.push(`      ${h.dependsOn}->${h.followup}（${h.priorIssue}）重叠 ${h.overlapMinutes}/${h.requiredOverlap} 分钟 ${h.met ? '满足' : '不满足'}${travelText}`);
  }
  lines.push('');

  lines.push('三、演练可行性与候选方案');
  for (const e of report.drills.evaluations) {
    lines.push(`  ${e.option} 第${e.day}天 ${e.window} ${e.venue}/${e.skill} 教官=${e.coach} ${e.feasible ? '可行' : '不可行'}`);
    for (const b of e.blockers) lines.push(`      [阻断] ${b.condition}: ${b.reason}`);
    for (const w of e.warnings) lines.push(`      [提示] ${w.condition}: ${w.reason}`);
    lines.push(`      可到学员=${e.eligibleSeats.join('|') || '无'} 容量=${e.capacity}`);
  }
  for (const n of report.drills.schedulingNotes) {
    lines.push(`  [排程 ${n.kind}] ${n.detail}`);
  }
  lines.push('  带教链（相接演练的两类前置条件）:');
  for (const c of report.drills.chains) {
    lines.push(`      ${c.chain} 主体=${c.subject} 要求=${c.requirement}：${c.interpretation}`);
    lines.push(`          应变: ${c.contingency}`);
  }
  lines.push('  候选方案:');
  for (const plan of report.plans) {
    lines.push(`    ${plan.id}「${plan.name}」演练=${plan.options.join('+')}${plan.conditional ? '（条件路径）' : ''}`);
    for (const c of plan.conditions ?? []) lines.push(`        前提: ${c}`);
    for (const a of plan.affectedArrangements) {
      lines.push(`        新增证据: ${a.student} 经 ${a.option} — ${a.newEvidenceCouldChange}`);
    }
    for (const h of plan.hardLimits) lines.push(`        硬约束: ${h}`);
  }
  lines.push('');

  lines.push('四、分派偏差与观察欠缺');
  if (report.assignmentBias.length === 0) lines.push('  无');
  for (const b of report.assignmentBias) {
    lines.push(`  ${b.venue}/${b.skill} solo占比=${b.soloShare}`);
    for (const f of b.flags) lines.push(`      [${f.code}] ${f.detail}`);
  }
  lines.push('');

  lines.push('五、估计可靠性（walk-forward 回溯）');
  lines.push(`  汇总: 样本=${report.reliability.aggregate.cases} 命中率=${report.reliability.aggregate.hitRate ?? '-'} Brier=${report.reliability.aggregate.brier ?? '-'}`);
  lines.push(`  说明: ${report.reliability.aggregate.note}`);
  for (const cp of report.reliability.checkpoints.filter(c => c.decided > 0)) {
    lines.push(`      第${cp.checkpointDay}天检查点: 样本=${cp.decided} 命中率=${cp.hitRate} Brier=${cp.brier}`);
  }
  lines.push('');

  lines.push('六、已锁定正式班的证据边界（历史快照与当前结论并存）');
  for (const s of report.lockedSnapshots) {
    lines.push(`  ${s.shift} 第${s.lockedOnDay}天锁定（${s.detail}）当时可见证据=${s.evidenceBoundary.visibleEvents.join('|') || '无'}`);
    for (const r of s.readinessAtLock) lines.push(`      锁定时: ${r.person} ${r.state} pSolo=${r.estimate.pSolo}`);
    for (const r of s.currentReadiness) lines.push(`      当前:   ${r.person} ${r.state} pSolo=${r.estimate.pSolo}`);
  }
  lines.push('');

  lines.push('七、现场负责人可追查的缺口清单');
  for (const g of report.auditGaps) {
    const cat = { 'qualification-gap': '资格缺口', 'coverage-gap': '覆盖不足', 'evidence-gap': '证据不足' }[g.category];
    lines.push(`  [${cat}] 来源=${g.source} 原因=${g.cause}`);
    lines.push(`      ${g.detail}`);
    lines.push(`      建议: ${g.recommendedAction}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await checkMaterials();
  const args = parseArgs(process.argv);
  const raw = await loadRawTables();
  const maxKnown = Math.max(...raw.observations.map(o => toNumber(o.known_day)));
  const asOfDay = args.day ?? maxKnown;
  const report = analyze(raw, asOfDay);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderText(report));
  }
}

export { loadRawTables, renderText };
