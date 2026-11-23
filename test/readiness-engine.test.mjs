import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyze,
  assignmentBias,
  backtest,
  betaEstimate,
  checkAllShifts,
  checkCrossShiftConflicts,
  clockToMinutes,
  credentialValidOn,
  evidenceForSlot,
  evidenceProfile,
  normalizeTables,
  buildIndexes,
  overlapMinutes,
  readinessFor,
  visibleObservations,
  evaluateOption,
  lockedSnapshots,
} from '../tools/readiness-engine.mjs';

// 构造最小原始表（字段顺序与 fixtures/format.json 一致）
function emptyRaw() {
  return {
    people: [],
    observations: [],
    shifts: [],
    options: [],
    'slot-rules': [],
    availability: [],
    travel: [],
    'training-conditions': [],
    'change-notices': [],
    'followup-shifts': [],
  };
}

function person(person, school, skill, from = '', to = '', standby = 'false') {
  return { person, school, skill, credential_from: String(from ?? ''), credential_to: String(to ?? ''), standby };
}
function obs(event, person, skill, kind, scheduledDay, knownDay, venue, supervision, outcome) {
  return { event, person, skill, kind, scheduled_day: String(scheduledDay), known_day: String(knownDay), venue, supervision, outcome };
}
function shift(shift, venue, day, start, end, skill, primary, backup = '', minOverlap = '0', locked = 'false') {
  return { shift, venue, day: String(day), start, end, skill, primary, backup, min_overlap: String(minOverlap), locked };
}
function option(option, day, start, end, venue, skill, coach, eligible, capacity) {
  return { option, day: String(day), start, end, venue, skill, coach, eligible_people: eligible, capacity: String(capacity) };
}
function slotRule(venue, skill, minCred, authority) {
  return { venue, skill, min_credentialed: String(minCred), coach_authority: authority };
}
function availability(person, day, from, to) {
  return { person, day: String(day), from, to };
}
function travel(from, to, minutes) {
  return { from, to, minutes: String(minutes) };
}
function condition(option, prerequisite, subject, required, knownDay) {
  return { option, prerequisite, subject, required, known_day: String(knownDay) };
}
function notice(notice, knownDay, subject, kind, detail) {
  return { notice, known_day: String(knownDay), subject, kind, detail };
}
function followup(shift, dependsOn, priorIssue, anticipatedDay) {
  return { shift, depends_on: dependsOn, prior_issue: priorIssue, anticipated_day: String(anticipatedDay) };
}

function build(raw, asOfDay) {
  const t = normalizeTables(raw);
  const index = buildIndexes(t);
  return { t, index, report: analyze(raw, asOfDay) };
}

// ---------- 基础工具 ----------

test('时钟与重叠区间按半开区间计算', () => {
  assert.equal(clockToMinutes('09:00'), 540);
  assert.equal(clockToMinutes('11:15'), 675);
  // [09:00,11:15) 与 [11:00,13:00) 重叠 15 分钟
  assert.equal(overlapMinutes(540, 675, 660, 780), 15);
  // 首尾相接不算重叠
  assert.equal(overlapMinutes(540, 660, 660, 720), 0);
});

test('Beta 估计：零证据时回到无信息先验，失败拉低概率并保留不确定性', () => {
  const none = betaEstimate(0, 0);
  assert.equal(none.pSolo, 0.5);
  assert.ok(none.uncertainty > 0);
  const pass = betaEstimate(3, 0);
  assert.equal(pass.pSolo, 0.8); // (1+3)/(1+3+1)
  const fail = betaEstimate(0, 2);
  assert.ok(fail.pSolo < 0.3);
  assert.ok(fail.uncertainty > 0);
});

// ---------- 凭据与证据可见性 ----------

test('凭据按签发有效期判断，无记录即无凭据', () => {
  const { index } = build({
    ...emptyRaw(),
    people: [
      person('P1', 'H1', 'radio', 5, 20),
      person('P2', 'H1', 'radio'),
    ],
    'slot-rules': [slotRule('A', 'radio', 1, 'radio')],
  }, 10);
  assert.equal(credentialValidOn(index.personMap.get('P1'), 10), true);
  assert.equal(credentialValidOn(index.personMap.get('P1'), 4), false);
  assert.equal(credentialValidOn(index.personMap.get('P1'), 21), false);
  assert.equal(credentialValidOn(index.personMap.get('P2'), 10), false);
});

test('known_day 晚于时点的观察不可见，cancel 与 no-show 不转默认合格', () => {
  const raw = {
    ...emptyRaw(),
    people: [person('P1', 'H1', 'radio', 1, 20)],
    'slot-rules': [slotRule('A', 'radio', 1, 'radio')],
    observations: [
      obs('E1', 'P1', 'radio', 'assessment', 5, 8, 'A', 'solo', 'pass'),
      obs('E2', 'P1', 'radio', 'rehearsal', 6, 12, 'A', 'solo', 'pass'),
      obs('E3', 'P1', 'radio', 'rehearsal', 7, 7, 'A', 'solo', 'cancelled'),
      obs('E4', 'P1', 'radio', 'assessment', 8, 8, 'A', 'solo', 'no-show'),
    ],
  };
  const { t } = build(raw, 9);
  const visible = visibleObservations(t, 9).map(o => o.event);
  assert.deepEqual(visible.sort(), ['E1', 'E3', 'E4']);
  const profile = evidenceProfile(evidenceForSlot(t, 'P1', 'A', 'radio', 9));
  assert.equal(profile.attended, 1);
  assert.equal(profile.cancelled, 1);
  assert.equal(profile.noShow, 1);
  assert.equal(profile.assessmentPass, 1); // E1 是 assessment+solo+pass
  assert.equal(profile.soloPass, 0);
});

test('考核或演练只有在技能与场馆都适用时才参与准备度估计', () => {
  const raw = {
    ...emptyRaw(),
    people: [person('P1', 'H1', 'radio', 1, 20)],
    'slot-rules': [slotRule('A', 'radio', 1, 'radio')],
    observations: [
      obs('E1', 'P1', 'radio', 'rehearsal', 5, 5, 'A', 'solo', 'pass'),
      obs('E2', 'P1', 'radio', 'rehearsal', 5, 5, 'B', 'solo', 'pass'), // B 馆无 radio 岗位规则
      obs('E3', 'P1', 'entry', 'rehearsal', 5, 5, 'A', 'solo', 'pass'), // 技能不匹配
    ],
  };
  const { t, index } = build(raw, 9);
  const r = readinessFor(t, index, 'P1', 'A', 'radio', 9);
  assert.equal(r.profile.events.length, 1);
  assert.equal(r.profile.events[0], 'E1');
});

// ---------- 准备度状态 ----------

test('有监督通过只能得到 supervised-only，不能独立当班', () => {
  const raw = {
    ...emptyRaw(),
    people: [person('P1', 'H1', 'entry', 1, 20)],
    'slot-rules': [slotRule('B', 'entry', 1, 'entry')],
    observations: [
      obs('E1', 'P1', 'entry', 'rehearsal', 5, 5, 'B', 'supervised', 'pass'),
      obs('E2', 'P1', 'entry', 'rehearsal', 6, 6, 'B', 'supervised', 'pass'),
    ],
  };
  const { t, index } = build(raw, 9);
  const r = readinessFor(t, index, 'P1', 'B', 'entry', 9);
  assert.equal(r.state, 'supervised-only');
  assert.ok(r.uncertainty !== null);
});

test('未持证优先于证据状态；solo 失败进入 evidence-failure', () => {
  const raw = {
    ...emptyRaw(),
    people: [
      person('P1', 'H1', 'radio', 12, 25),
      person('P2', 'H1', 'radio', 1, 25),
    ],
    'slot-rules': [slotRule('A', 'radio', 1, 'radio')],
    observations: [
      obs('E1', 'P1', 'radio', 'rehearsal', 5, 5, 'A', 'solo', 'pass'),
      obs('E2', 'P2', 'radio', 'rehearsal', 5, 5, 'A', 'solo', 'fail'),
    ],
  };
  const { t, index } = build(raw, 10);
  const r1 = readinessFor(t, index, 'P1', 'A', 'radio', 10);
  assert.equal(r1.state, 'not-credentialed');
  const r2 = readinessFor(t, index, 'P2', 'A', 'radio', 10);
  assert.equal(r2.state, 'evidence-failure');
});

test('只有取消或缺考时保持证据不足，且原因明确区分', () => {
  const raw = {
    ...emptyRaw(),
    people: [
      person('P1', 'H1', 'radio', 1, 20),
      person('P2', 'H1', 'radio', 1, 20),
    ],
    'slot-rules': [slotRule('A', 'radio', 1, 'radio')],
    observations: [
      obs('E1', 'P1', 'radio', 'rehearsal', 5, 5, 'A', 'solo', 'cancelled'),
      obs('E2', 'P2', 'radio', 'assessment', 5, 5, 'A', 'solo', 'no-show'),
    ],
  };
  const { t, index } = build(raw, 9);
  const r1 = readinessFor(t, index, 'P1', 'A', 'radio', 9);
  const r2 = readinessFor(t, index, 'P2', 'A', 'radio', 9);
  assert.equal(r1.state, 'insufficient-evidence');
  assert.match(r1.reasons.join(), /取消/);
  assert.equal(r2.state, 'insufficient-evidence');
  assert.match(r2.reasons.join(), /缺考/);
});

// ---------- 排班缺口 ----------

test('主岗未持证是资格缺口，评分再高也不取消硬性要求', () => {
  const raw = {
    ...emptyRaw(),
    people: [
      person('P1', 'H1', 'radio', 12, 25),
      person('P2', 'H1', 'radio', 1, 25),
    ],
    'slot-rules': [slotRule('A', 'radio', 1, 'radio')],
    shifts: [shift('F1', 'A', 10, '09:00', '11:00', 'radio', 'P1', 'P2')],
  };
  const checks = checkAllShifts(...engineArgs(raw, 10));
  const codes = checks.perShift[0].findings.map(f => f.code);
  assert.ok(codes.includes('primary-not-credentialed'));
});

test('同一人时间重叠的两个班次产生双重排班冲突', () => {
  const raw = {
    ...emptyRaw(),
    people: [
      person('P1', 'H1', 'radio', 1, 25),
      person('P2', 'H1', 'radio', 1, 25),
      person('P3', 'H1', 'radio', 1, 25),
    ],
    'slot-rules': [slotRule('A', 'radio', 1, 'radio'), slotRule('B', 'radio', 1, 'radio')],
    travel: [travel('A', 'B', 30)],
    shifts: [
      shift('F1', 'A', 10, '09:00', '11:00', 'radio', 'P2', 'P1'),
      shift('F2', 'B', 10, '10:30', '12:00', 'radio', 'P3', 'P1'),
    ],
  };
  const { t, index } = build(raw, 10);
  const conflicts = checkCrossShiftConflicts(t, index, 10);
  assert.ok(conflicts.some(c => c.kind === 'simultaneous-double-booking' && c.person === 'P1'));
});

test('跨馆相接班次间隔不足 travel 要求时判不能保证交接', () => {
  const raw = {
    ...emptyRaw(),
    people: [
      person('P1', 'H1', 'radio', 1, 25),
      person('P2', 'H1', 'radio', 1, 25),
    ],
    'slot-rules': [slotRule('A', 'radio', 1, 'radio'), slotRule('B', 'radio', 1, 'radio')],
    travel: [travel('A', 'B', 30), travel('B', 'A', 35)],
    shifts: [
      shift('F1', 'A', 10, '09:00', '10:00', 'radio', 'P1'),
      shift('F2', 'B', 10, '10:20', '11:30', 'radio', 'P1'),
    ],
  };
  const { t, index } = build(raw, 10);
  const conflicts = checkCrossShiftConflicts(t, index, 10);
  const gap = conflicts.find(c => c.kind === 'travel-gap-unmet');
  assert.ok(gap);
  assert.match(gap.detail, /20 分钟/);
  // 间隔足够时不报
  const raw2 = { ...raw, shifts: [
    shift('F1', 'A', 10, '09:00', '10:00', 'radio', 'P1'),
    shift('F2', 'B', 10, '10:35', '11:30', 'radio', 'P1'),
  ] };
  const built2 = build(raw2, 10);
  assert.equal(checkCrossShiftConflicts(built2.t, built2.index, 10).filter(c => c.kind === 'travel-gap-unmet').length, 0);
});

test('持证人数下限不满足时给覆盖缺口', () => {
  const raw = {
    ...emptyRaw(),
    people: [
      person('P1', 'H1', 'radio', 1, 25),
      person('P2', 'H1', 'radio'),
    ],
    'slot-rules': [slotRule('B', 'radio', 2, 'radio')],
    shifts: [shift('F1', 'B', 10, '09:00', '11:00', 'radio', 'P1', 'P2')],
  };
  const checks = checkAllShifts(...engineArgs(raw, 10));
  assert.ok(checks.perShift[0].findings.some(f => f.code === 'min-credentialed-unmet'));
});

// ---------- 演练可行性 ----------

test('教官技能不匹配或凭据无效时演练不可行', () => {
  const raw = {
    ...emptyRaw(),
    people: [
      person('C1', 'H1', 'radio', 1, 25),
      person('C2', 'H1', 'radio', 12, 25),
      person('S1', 'H1', 'radio', 1, 25),
    ],
    'slot-rules': [slotRule('A', 'radio', 1, 'radio')],
    availability: [availability('C1', 8, '08:00', '12:00'), availability('C2', 8, '08:00', '12:00'), availability('S1', 8, '08:00', '12:00')],
    options: [
      option('Q1', 8, '09:00', '10:00', 'A', 'entry', 'C1', 'S1', 1),
      option('Q2', 8, '11:00', '12:00', 'A', 'radio', 'C2', 'S1', 1),
    ],
  };
  const { t, index } = build(raw, 7);
  const q1 = evaluateOption(t, index, t.options[0], 7);
  const q2 = evaluateOption(t, index, t.options[1], 7);
  assert.equal(q1.feasible, false);
  assert.ok(q1.blockers.some(b => b.condition === 'coach'));
  assert.equal(q2.feasible, false);
  assert.match(q2.blockers.find(b => b.condition === 'coach').reason, /凭据无效/);
});

test('credential-confirmed 前置不把计划考核当通过；attendance 前置在未发生时保留名额', () => {
  const raw = {
    ...emptyRaw(),
    people: [
      person('V3', 'H1', 'radio', 12, 25),
      person('V4', 'H1', 'radio', 1, 25),
      person('V1', 'H1', 'radio', 1, 25),
    ],
    'slot-rules': [slotRule('A', 'radio', 1, 'radio'), slotRule('B', 'radio', 1, 'radio')],
    availability: [
      availability('V4', 9, '15:00', '18:00'), availability('V3', 9, '15:00', '18:00'),
      availability('V1', 8, '08:00', '12:00'), availability('V3', 8, '08:00', '12:00'),
      availability('V4', 8, '08:00', '12:00'),
    ],
    options: [
      option('P3', 9, '16:00', '17:00', 'A', 'radio', 'V4', 'V3', 1),
      option('P4', 9, '17:05', '18:40', 'B', 'radio', 'V3', 'V1|V4', 2),
      option('P1', 8, '08:00', '09:30', 'A', 'radio', 'V1', 'V3|V4', 1),
      option('P5', 8, '10:05', '11:10', 'B', 'radio', 'V4', 'V1|V3', 1),
    ],
    'training-conditions': [
      condition('P4', 'P3', 'V3', 'credential-confirmed', 7),
      condition('P5', 'P1', 'V3', 'attendance', 7),
    ],
  };
  const { t, index } = build(raw, 7);
  const p4 = evaluateOption(t, index, t.options.find(o => o.option === 'P4'), 7);
  assert.equal(p4.feasible, false);
  assert.ok(p4.blockers.some(b => b.condition === 'credential-confirmed'));
  const p5 = evaluateOption(t, index, t.options.find(o => o.option === 'P5'), 7);
  assert.equal(p5.feasible, true);
  assert.ok(p5.warnings.some(w => w.condition === 'attendance-pending'));
});

// ---------- 分派偏差 ----------

test('熟练者独占 solo 机会且被排班者无 solo 证据时标记偏差与观察欠缺', () => {
  const raw = {
    ...emptyRaw(),
    people: [
      person('Expert', 'H1', 'radio', 1, 25),
      person('Novice', 'H1', 'radio', 1, 25),
    ],
    'slot-rules': [slotRule('A', 'radio', 1, 'radio')],
    observations: [
      obs('E1', 'Expert', 'radio', 'rehearsal', 1, 1, 'A', 'solo', 'pass'),
      obs('E2', 'Expert', 'radio', 'rehearsal', 2, 2, 'A', 'solo', 'pass'),
      obs('E3', 'Novice', 'radio', 'rehearsal', 2, 2, 'A', 'supervised', 'fail'),
    ],
    shifts: [shift('F1', 'A', 10, '09:00', '11:00', 'radio', 'Novice', 'Expert')],
  };
  const { t, index } = build(raw, 9);
  const reports = assignmentBias(t, index, 9);
  const radio = reports.find(r => r.venue === 'A' && r.skill === 'radio');
  assert.ok(radio.flags.some(f => f.code === 'assignment-bias'));
  assert.ok(radio.flags.some(f => f.code === 'observation-deficiency' && f.person === 'Novice'));
});

// ---------- 回溯检验 ----------

test('walk-forward 回溯排除 cancel，且只用当时可见资料预测', () => {
  const raw = {
    ...emptyRaw(),
    people: [person('P1', 'H1', 'radio', 1, 25)],
    'slot-rules': [slotRule('A', 'radio', 1, 'radio')],
    observations: [
      obs('E1', 'P1', 'radio', 'rehearsal', 1, 1, 'A', 'solo', 'pass'),
      obs('E2', 'P1', 'radio', 'rehearsal', 2, 2, 'A', 'solo', 'cancelled'),
      obs('E3', 'P1', 'radio', 'rehearsal', 3, 3, 'A', 'solo', 'pass'),
      obs('E4', 'P1', 'radio', 'rehearsal', 4, 9, 'A', 'solo', 'fail'), // 第 9 天才录入
    ],
  };
  const { t, index } = build(raw, 8);
  const result = backtest(t, index);
  const day2 = result.checkpoints.find(c => c.checkpointDay === 2);
  assert.equal(day2.decided, 0); // cancel 不计样本
  // 第 4 天检查点看不到 E4（known_day=9），因此 E4 自身在 asOf=3 时无后续样本外预测问题，
  // 但 E4 在第 4 天检查点因对分析者不可见而不会进入“已知实际”——验证样本只含可见实际
  const allEvents = result.checkpoints.flatMap(c => c.cases.map(x => x.event));
  assert.ok(!allEvents.includes('E2'));
});

// ---------- 锁定证据边界 ----------

test('锁定班次保留锁定时点的证据边界，同时给出当前准备度', () => {
  const raw = {
    ...emptyRaw(),
    people: [
      person('P1', 'H1', 'radio', 1, 25),
      person('P2', 'H1', 'radio', 1, 25),
    ],
    'slot-rules': [slotRule('B', 'radio', 1, 'radio')],
    observations: [
      obs('E1', 'P1', 'radio', 'rehearsal', 5, 5, 'B', 'solo', 'pass'),
      obs('E2', 'P1', 'radio', 'rehearsal', 9, 9, 'B', 'solo', 'pass'),
    ],
    shifts: [shift('F2', 'B', 10, '09:00', '11:00', 'radio', 'P1', 'P2')],
    'change-notices': [notice('N2', 7, 'F2', 'locked', '场馆已收确认')],
  };
  const { t, index } = build(raw, 9);
  const snaps = lockedSnapshots(t, index);
  assert.equal(snaps.length, 1);
  assert.deepEqual(snaps[0].evidenceBoundary.visibleEvents, ['E1']);
  assert.equal(snaps[0].currentReadiness.find(r => r.person === 'P1').profile.events.length, 2);
});

// ---------- 端到端：真实 fixtures 的关键结论 ----------

test('真实 fixtures 端到端：V3 第 10 天未持证、V1 跨馆冲突、P4 不可行', async () => {
  const { default: raw } = await import('./fixture-loader.mjs');
  const report = analyze(raw, 9);
  const v3a = report.readiness.find(r => r.person === 'V3' && r.venue === 'A');
  assert.equal(v3a.state, 'not-credentialed');
  assert.ok(report.shiftChecks.crossConflicts.some(c => c.person === 'V1' && c.kind === 'simultaneous-double-booking'));
  const p4 = report.drills.evaluations.find(e => e.option === 'P4');
  assert.equal(p4.feasible, false);
  // 取消的 O3 出现在审计缺口但不算失败
  assert.ok(report.auditGaps.some(g => g.source === 'O3' && g.cause === 'drill-cancelled'));
  // 晚录入的 O7 在第 9 天不可见
  assert.ok(report.auditGaps.some(g => g.source === 'O7' && g.cause === 'record-entered-late'));
});

function engineArgs(raw, asOfDay) {
  const t = normalizeTables(raw);
  return [t, buildIndexes(t), asOfDay];
}
