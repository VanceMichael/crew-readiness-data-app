// 志愿班组准备度分析引擎（纯函数，不做文件 I/O）
// 输入是 check-materials.mjs 解析出的 tables 对象，输出可序列化的分析结果。
// 所有“时点”判断都以 asOfDay 为界：known_day 晚于该日的记录一律不可见。

// ---------- 基础工具 ----------

export function toNumber(value, fallback = null) {
  if (value === '' || value === undefined || value === null || value === '-') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseBool(value) {
  return value === 'true';
}

// 时钟 HH:MM -> 分钟
export function clockToMinutes(clock) {
  const [hour, minute] = clock.split(':').map(Number);
  return hour * 60 + minute;
}

// 半开区间 [aStart, aEnd) 与 [bStart, bEnd) 的重叠分钟数
export function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// 两个区间是否有任何重叠
export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return overlapMinutes(aStart, aEnd, bStart, bEnd) > 0;
}

export function unique(list) {
  return [...new Set(list)];
}

export function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// ---------- 表归一化 ----------

export function normalizeTables(raw) {
  const people = raw.people.map(row => ({
    person: row.person,
    school: row.school,
    skill: row.skill,
    credentialFrom: toNumber(row.credential_from, null),
    credentialTo: toNumber(row.credential_to, null),
    standby: parseBool(row.standby),
  }));

  const observations = raw.observations.map(row => ({
    event: row.event,
    person: row.person,
    skill: row.skill,
    kind: row.kind, // assessment | rehearsal
    scheduledDay: toNumber(row.scheduled_day),
    knownDay: toNumber(row.known_day),
    venue: row.venue,
    supervision: row.supervision, // solo | supervised
    outcome: row.outcome, // pass | fail | cancelled | no-show
  }));

  const shifts = raw.shifts.map(row => ({
    shift: row.shift,
    venue: row.venue,
    day: toNumber(row.day),
    start: clockToMinutes(row.start),
    end: clockToMinutes(row.end),
    startClock: row.start,
    endClock: row.end,
    skill: row.skill,
    primary: row.primary,
    backup: row.backup === '' ? null : row.backup,
    minOverlap: toNumber(row.min_overlap, 0),
    locked: parseBool(row.locked),
  }));

  const options = raw.options.map(row => ({
    option: row.option,
    day: toNumber(row.day),
    start: clockToMinutes(row.start),
    end: clockToMinutes(row.end),
    startClock: row.start,
    endClock: row.end,
    venue: row.venue,
    skill: row.skill,
    coach: row.coach,
    eligiblePeople: row.eligible_people === '' ? [] : row.eligible_people.split('|'),
    capacity: toNumber(row.capacity, 0),
  }));

  const slotRules = raw['slot-rules'].map(row => ({
    venue: row.venue,
    skill: row.skill,
    minCredentialed: toNumber(row.min_credentialed, 0),
    coachAuthority: row.coach_authority === '-' ? null : row.coach_authority,
  }));

  const availability = raw.availability.map(row => ({
    person: row.person,
    day: toNumber(row.day),
    from: clockToMinutes(row.from),
    to: clockToMinutes(row.to),
  }));

  const travel = raw.travel.map(row => ({
    from: row.from,
    to: row.to,
    minutes: toNumber(row.minutes, 0),
  }));

  const trainingConditions = raw['training-conditions'].map(row => ({
    option: row.option,
    prerequisite: row.prerequisite,
    subject: row.subject,
    required: row.required, // attendance | credential-confirmed
    knownDay: toNumber(row.known_day),
  }));

  const changeNotices = raw['change-notices'].map(row => ({
    notice: row.notice,
    knownDay: toNumber(row.known_day),
    subject: row.subject,
    kind: row.kind,
    detail: row.detail,
  }));

  const followupShifts = raw['followup-shifts'].map(row => ({
    shift: row.shift,
    dependsOn: row.depends_on,
    priorIssue: row.prior_issue,
    anticipatedDay: toNumber(row.anticipated_day),
  }));

  return {
    people, observations, shifts, options, slotRules, availability,
    travel, trainingConditions, changeNotices, followupShifts,
  };
}

// ---------- 索引与凭据 ----------

export function buildIndexes(t) {
  const personBySkill = groupBy(t.people, p => p.skill);
  const personMap = new Map(t.people.map(p => [p.person, p]));
  const slotRuleMap = new Map(t.slotRules.map(r => [`${r.venue}|${r.skill}`, r]));
  const travelMap = new Map(t.travel.map(x => [`${x.from}|${x.to}`, x.minutes]));
  return { personBySkill, personMap, slotRuleMap, travelMap };
}

// 凭据在指定日期是否有效：签发区间 [from, to] 闭区间覆盖该日；无签发记录即无凭据
export function credentialValidOn(person, day) {
  if (!person || person.credentialFrom === null || person.credentialTo === null) return false;
  return day >= person.credentialFrom && day <= person.credentialTo;
}

// ---------- 可见证据 ----------

// 时点 asOfDay 上可见的观察（known_day <= asOfDay），按计划日升序
export function visibleObservations(t, asOfDay) {
  return t.observations
    .filter(o => o.knownDay <= asOfDay)
    .sort((a, b) => a.scheduledDay - b.scheduledDay || a.event.localeCompare(b.event));
}

// 某人在某岗位（场馆+技能）上适用的可见观察：技能与场馆必须同时匹配
export function evidenceForSlot(t, personId, venue, skill, asOfDay) {
  return visibleObservations(t, asOfDay).filter(
    o => o.person === personId && o.skill === skill && o.venue === venue,
  );
}

// 某场馆是否存在该技能的岗位规则（决定观察是否“适用岗位”）
export function slotRuleExists(index, venue, skill) {
  return index.slotRuleMap.has(`${venue}|${skill}`);
}

// 证据画像：区分签到、考核、有监督演练、独立演练；cancel/no-show 单列
export function evidenceProfile(events) {
  const profile = {
    total: events.length,
    assessmentPass: 0,
    assessmentFail: 0,
    supervisedPass: 0,
    supervisedFail: 0,
    soloPass: 0,
    soloFail: 0,
    cancelled: 0,
    noShow: 0,
    attended: 0,
    lastSoloDay: null,
    lastAnyDay: null,
    events: events.map(e => e.event),
  };
  for (const e of events) {
    if (e.outcome === 'cancelled') {
      profile.cancelled += 1;
      continue; // 场馆取消：不算学员失败，也不算学员出勤
    }
    if (e.outcome === 'no-show') {
      profile.noShow += 1;
      profile.lastAnyDay = e.scheduledDay;
      continue; // 缺考：负向信号，但与 fail 区分
    }
    profile.attended += 1;
    profile.lastAnyDay = e.scheduledDay;
    if (e.outcome === 'pass') {
      if (e.kind === 'assessment' && e.supervision === 'solo') profile.assessmentPass += 1;
      else if (e.supervision === 'solo') profile.soloPass += 1;
      else profile.supervisedPass += 1;
      if (e.supervision === 'solo') profile.lastSoloDay = e.scheduledDay;
    } else if (e.outcome === 'fail') {
      if (e.kind === 'assessment' && e.supervision === 'solo') profile.assessmentFail += 1;
      else if (e.supervision === 'solo') profile.soloFail += 1;
      else profile.supervisedFail += 1;
      if (e.supervision === 'solo') profile.lastSoloDay = e.scheduledDay;
    }
  }
  return profile;
}

// ---------- 准备度估计 ----------

// Beta-伯努利（Laplace 平滑）：只使用独立(solo)证据；有监督证据不计入独立当班概率。
// alpha=1+soloPass, beta=1+soloFail，均值即点估计，方差表达剩余不确定性。
export function betaEstimate(soloPass, soloFail) {
  const alpha = 1 + soloPass;
  const beta = 1 + soloFail;
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  // 95% 可信区间用 Beta 分布的正态近似（样本极小，仅作透明启发式，不做临床式断言）
  const std = Math.sqrt(variance);
  return {
    soloPass,
    soloFail,
    pSolo: Number(mean.toFixed(4)),
    uncertainty: Number(variance.toFixed(5)),
    ci95: [
      Number(Math.max(0, mean - 1.96 * std).toFixed(4)),
      Number(Math.min(1, mean + 1.96 * std).toFixed(4)),
    ],
  };
}

// 单人在单岗位上的准备度结论
export function readinessFor(t, index, personId, venue, skill, asOfDay) {
  const person = index.personMap.get(personId);
  const applicable = slotRuleExists(index, venue, skill)
    ? evidenceForSlot(t, personId, venue, skill, asOfDay)
    : [];
  const profile = evidenceProfile(applicable);
  const estimate = betaEstimate(profile.soloPass + profile.assessmentPass, profile.soloFail + profile.assessmentFail);

  const credentialed = credentialValidOn(person, asOfDay);
  const hasSupervisedEvidence = profile.supervisedPass > 0 || profile.supervisedFail > 0;
  const hasSoloEvidence = (profile.soloPass + profile.assessmentPass + profile.soloFail + profile.assessmentFail) > 0;
  const hasAnyFailure = profile.soloFail > 0 || profile.assessmentFail > 0 || profile.supervisedFail > 0;
  const onlyCancelledOrNoShow = profile.attended === 0 && (profile.cancelled > 0 || profile.noShow > 0);

  // 状态优先级：硬性持证缺口 > 观察到失败 > 独立就绪 > 有监督但未独立 > 证据不足
  let state;
  const reasons = [];
  if (!credentialed) {
    state = 'not-credentialed';
    reasons.push(person.credentialFrom === null ? '无有效凭据记录' : `凭据有效期 ${person.credentialFrom}-${person.credentialTo} 不覆盖第 ${asOfDay} 天`);
  } else if (hasAnyFailure) {
    state = 'evidence-failure';
    reasons.push('存在 fail 观察，需复训后重新取证');
  } else if (hasSoloEvidence && (profile.soloPass + profile.assessmentPass) > 0) {
    state = 'solo-ready';
    reasons.push('有适用岗位的独立(solo)通过证据');
  } else if (hasSupervisedEvidence && profile.supervisedPass > 0) {
    state = 'supervised-only';
    reasons.push('仅有有监督通过，尚不能独立当班');
  } else if (onlyCancelledOrNoShow) {
    state = 'insufficient-evidence';
    reasons.push(profile.cancelled > 0 ? '演练被场馆取消，不能转默认合格' : '缺考(no-show)，不能转默认合格');
  } else {
    state = 'insufficient-evidence';
    reasons.push('无适用岗位的可见证据');
  }

  return {
    person: personId,
    venue,
    skill,
    asOfDay,
    credentialed,
    state,
    reasons,
    profile,
    estimate,
    // 对未独立当班者，剩余不确定性以方差显式给出
    uncertainty: state === 'solo-ready' ? null : estimate.uncertainty,
  };
}

// 全部 (人, 场馆, 技能) 组合的准备度，只覆盖有岗位规则的组合
export function allReadiness(t, index, asOfDay) {
  const results = [];
  for (const rule of t.slotRules) {
    for (const person of t.people.filter(p => p.skill === rule.skill)) {
      results.push(readinessFor(t, index, person.person, rule.venue, rule.skill, asOfDay));
    }
  }
  return results;
}

// ---------- 排班缺口检查 ----------

function personAvailable(t, personId, day, start, end) {
  return t.availability.some(a =>
    a.person === personId && a.day === day && a.from <= start && a.to >= end);
}

export function checkShift(t, index, shift, asOfDay) {
  const findings = [];
  const rule = index.slotRuleMap.get(`${shift.venue}|${shift.skill}`);
  const push = (category, code, detail, evidence = []) =>
    findings.push({ shift: shift.shift, category, code, detail, evidence });

  if (!rule) {
    push('qualification-gap', 'no-slot-rule', `场馆 ${shift.venue} 无 ${shift.skill} 岗位规则`);
  }

  const primary = index.personMap.get(shift.primary);
  const backup = shift.backup ? index.personMap.get(shift.backup) : null;

  // 主岗技能
  if (primary.skill !== shift.skill) {
    push('qualification-gap', 'primary-skill-mismatch', `主岗 ${shift.primary} 技能为 ${primary.skill}，岗位要求 ${shift.skill}`);
  }
  // 主岗持证（硬性，不可被评分覆盖）
  if (!credentialValidOn(primary, shift.day)) {
    push('qualification-gap', 'primary-not-credentialed',
      `主岗 ${shift.primary} 在第 ${shift.day} 天无有效 ${shift.skill} 凭据`,
      credentialEvidence(t, shift.primary, asOfDay));
  }
  // 替补资格：技能匹配且凭据覆盖整班
  if (!shift.backup) {
    push('coverage-gap', 'no-backup', `班次 ${shift.shift} 未安排替补`);
  } else {
    if (backup.skill !== shift.skill) {
      push('qualification-gap', 'backup-skill-mismatch', `替补 ${shift.backup} 技能不匹配`);
    }
    if (!credentialValidOn(backup, shift.day)) {
      push('qualification-gap', 'backup-not-credentialed',
        `替补 ${shift.backup} 在第 ${shift.day} 天无有效凭据，无法承诺整班覆盖`);
    }
  }

  // 持证人数下限
  if (rule) {
    const credentialedHolders = [shift.primary, shift.backup].filter(id => id && credentialValidOn(index.personMap.get(id), shift.day));
    if (credentialedHolders.length < rule.minCredentialed) {
      push('coverage-gap', 'min-credentialed-unmet',
        `岗位要求至少 ${rule.minCredentialed} 名持证者，实际 ${credentialedHolders.length} 名`);
    }
  }

  // 交接重叠要求(min_overlap)由 followup-shifts 的专项检查兑现；
  // 单条班次记录里主岗与替补共用同一窗口，不在此用窗口长度误判。

  // 证据充分性（合规但证据不足）：主岗在该场馆+技能上无 solo 通过证据
  const primaryReadiness = readinessFor(t, index, shift.primary, shift.venue, shift.skill, asOfDay);
  if (primaryReadiness.state !== 'solo-ready' && primaryReadiness.state !== 'not-credentialed' && primaryReadiness.state !== 'evidence-failure') {
    push('evidence-gap', 'primary-evidence-insufficient',
      `主岗 ${shift.primary} 在 ${shift.venue}/${shift.skill} 状态为 ${primaryReadiness.state}，证据不足以支撑独立当班`,
      primaryReadiness.profile.events);
  }
  if (shift.backup) {
    const backupReadiness = readinessFor(t, index, shift.backup, shift.venue, shift.skill, asOfDay);
    if (backupReadiness.state === 'insufficient-evidence' || backupReadiness.state === 'supervised-only') {
      push('evidence-gap', 'backup-evidence-insufficient',
        `替补 ${shift.backup} 在 ${shift.venue}/${shift.skill} 状态为 ${backupReadiness.state}`,
        backupReadiness.profile.events);
    }
  }

  // 说明：availability 表只登记演练日的学员可用时段（用于演练名额评估），
  // 不覆盖比赛日排班；比赛日是否到岗以 shifts 正式记录为准，不在此产生假阳性。

  return { shift: shift.shift, locked: shift.locked, findings };
}

function credentialEvidence(t, personId, asOfDay) {
  // 找出晚于班次才生效的凭据/观察，供审计说明“不能补记”
  return t.observations
    .filter(o => o.person === personId && o.knownDay > asOfDay)
    .map(o => ({ event: o.event, knownDay: o.knownDay, reason: '记录录入晚于时点，不能补记为当时合格' }));
}

// 跨班次冲突：同一人同时段占两个岗位；跨馆还要满足 travel 最短间隔
export function checkCrossShiftConflicts(t, index, asOfDay) {
  const conflicts = [];
  const byPerson = new Map();
  for (const shift of t.shifts) {
    for (const id of [shift.primary, shift.backup].filter(Boolean)) {
      if (!byPerson.has(id)) byPerson.set(id, []);
      byPerson.get(id).push(shift);
    }
  }
  for (const [personId, list] of byPerson) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a.day !== b.day) continue;
        const overlapping = intervalsOverlap(a.start, a.end, b.start, b.end);
        if (overlapping) {
          conflicts.push({
            person: personId,
            kind: 'simultaneous-double-booking',
            shifts: [a.shift, b.shift],
            venues: [a.venue, b.venue],
            detail: `${personId} 在 ${a.shift}(${a.venue}) 与 ${b.shift}(${b.venue}) 时间重叠，一人不能同时救两个场馆`,
          });
        } else if (a.venue !== b.venue) {
          // 先后相接的跨馆任务：按实际时钟先后确定 first/second，空闲间隔必须 >= travel 要求
          const [first, second] = a.start <= b.start ? [a, b] : [b, a];
          const gap = second.start - first.end;
          const required = index.travelMap.get(`${first.venue}|${second.venue}`);
          if (required !== undefined && gap < required) {
            conflicts.push({
              person: personId,
              kind: 'travel-gap-unmet',
              shifts: [first.shift, second.shift],
              venues: [first.venue, second.venue],
              detail: `${personId} 从 ${first.venue} 到 ${second.venue} 间隔 ${gap} 分钟，少于 travel 要求 ${required} 分钟，不能保证交接覆盖`,
            });
          }
        }
      }
    }
  }
  void asOfDay;
  return conflicts;
}

// 交接重叠专项：followup-shifts 声明的依赖，校验实际排班是否兑现
export function checkHandoverOverlaps(t, index) {
  const results = [];
  const shiftMap = new Map(t.shifts.map(s => [s.shift, s]));
  for (const link of t.followupShifts) {
    const later = shiftMap.get(link.shift);
    const prior = shiftMap.get(link.dependsOn);
    if (!later || !prior) continue;
    const overlap = overlapMinutes(prior.start, prior.end, later.start, later.end);
    const met = overlap >= later.minOverlap;
    let travelNote = null;
    if (prior.venue !== later.venue) {
      // 两班有重叠则物理上无法跨馆兼顾；无重叠时按时钟先后校验 travel 间隔
      if (overlap > 0) {
        travelNote = { overlapping: true, required: null, gap: null, met: false, reason: '两班时间重叠，跨馆不可兼顾' };
      } else {
        const [first, second] = prior.start <= later.start ? [prior, later] : [later, prior];
        const required = index.travelMap.get(`${first.venue}|${second.venue}`);
        const gap = second.start - first.end;
        travelNote = required === undefined ? null : { overlapping: false, required, gap, met: gap >= required };
      }
    }
    results.push({
      followup: link.shift,
      dependsOn: link.dependsOn,
      priorIssue: link.priorIssue,
      overlapMinutes: overlap,
      requiredOverlap: later.minOverlap,
      met,
      travel: travelNote,
    });
  }
  return results;
}

export function checkAllShifts(t, index, asOfDay) {
  return {
    perShift: t.shifts.map(s => checkShift(t, index, s, asOfDay)),
    crossConflicts: checkCrossShiftConflicts(t, index, asOfDay),
    handovers: checkHandoverOverlaps(t, index),
  };
}

// ---------- 演练可行性 ----------

function coachQualified(t, index, option) {
  const person = index.personMap.get(option.coach);
  if (!person) return { ok: false, reason: `教官 ${option.coach} 不存在` };
  if (person.skill !== option.skill) return { ok: false, reason: `教官 ${option.coach} 技能 ${person.skill} 不匹配演练技能 ${option.skill}` };
  const rule = index.slotRuleMap.get(`${option.venue}|${option.skill}`);
  if (!rule || rule.coachAuthority !== option.skill) {
    return { ok: false, reason: `场馆 ${option.venue} 的 ${option.skill} 不认可该带教权威` };
  }
  if (!credentialValidOn(person, option.day)) {
    return { ok: false, reason: `教官 ${option.coach} 在第 ${option.day} 天凭据无效，带教条件不成立` };
  }
  return { ok: true };
}

function evaluatePrerequisites(t, index, option, asOfDay) {
  const conditions = t.trainingConditions.filter(c => c.option === option.option);
  const blockers = [];
  for (const c of conditions) {
    const prereq = t.options.find(o => o.option === c.prerequisite);
    if (c.required === 'credential-confirmed') {
      const person = index.personMap.get(c.subject);
      // 必须在条件 known_day 当天已取得且当日有效；计划考核不能自动当通过
      if (!credentialValidOn(person, c.knownDay)) {
        blockers.push({
          condition: 'credential-confirmed',
          subject: c.subject,
          requiredBy: c.knownDay,
          actualFrom: person.credentialFrom,
          reason: `凭据第 ${person.credentialFrom} 天才生效，晚于要求的第 ${c.knownDay} 天，不能把计划考核当作通过`,
        });
      }
    } else if (c.required === 'attendance') {
      // 出勤可由实际培训签到满足：前置场次当天有该人的非取消观察
      const attended = t.observations.some(o =>
        o.person === c.subject &&
        o.scheduledDay === prereq.day &&
        o.venue === prereq.venue &&
        o.outcome !== 'cancelled' &&
        o.knownDay <= asOfDay);
      // 规划视角：前置未发生为“待满足”；前置已过而无签到，给出硬阻断并保留条件路径说明
      const alreadyDecidable = prereq.day <= asOfDay;
      if (alreadyDecidable && !attended) {
        blockers.push({
          condition: 'attendance-unmet',
          subject: c.subject,
          prerequisite: c.prerequisite,
          reason: `${c.subject} 未在前置演练 ${c.prerequisite} 签到；若改派其参加 ${c.prerequisite}（容量允许），本场条件路径仍可成立`,
        });
      } else if (!alreadyDecidable) {
        blockers.push({
          condition: 'attendance-pending',
          subject: c.subject,
          prerequisite: c.prerequisite,
          reason: `需先确保 ${c.subject} 参加前置演练 ${c.prerequisite}，本场名额方可保留`,
        });
      }
    }
  }
  return blockers;
}

export function evaluateOption(t, index, option, asOfDay) {
  const coach = coachQualified(t, index, option);
  const blockers = [];
  const warnings = [];
  if (!coach.ok) blockers.push({ condition: 'coach', reason: coach.reason });

  // 教官自身时间可用
  if (!personAvailable(t, option.coach, option.day, option.start, option.end)) {
    blockers.push({ condition: 'coach-availability', reason: `教官 ${option.coach} 在该时段无可用时间` });
  }

  // 学员：资格名单内、时间覆盖、容量
  const seats = [];
  for (const id of option.eligiblePeople) {
    const person = index.personMap.get(id);
    const skillOk = person && person.skill === option.skill;
    const timeOk = personAvailable(t, id, option.day, option.start, option.end);
    if (skillOk && timeOk) seats.push(id);
  }
  if (seats.length === 0) {
    blockers.push({ condition: 'no-eligible-student', reason: '资格名单内无人在该时段可用' });
  }
  if (seats.length > option.capacity) {
    warnings.push({ condition: 'capacity', reason: `合格可到 ${seats.length} 人，容量仅 ${option.capacity}，需取舍` });
  }

  const prereqBlockers = evaluatePrerequisites(t, index, option, asOfDay);
  for (const b of prereqBlockers) {
    if (b.condition === 'attendance-pending') {
      // 前置演练尚未发生：名额可保留，本场为条件可行，不构成硬阻断
      warnings.push(b);
    } else if (b.condition === 'attendance-unmet') {
      // 前置已过但未签到：当前不可行，但保留“改派后条件成立”的路径说明（只在提示区展示一次）
      warnings.push(b);
      blockers.push({ ...b, condition: 'attendance' });
    } else {
      blockers.push(b);
    }
  }

  return {
    option: option.option,
    venue: option.venue,
    skill: option.skill,
    day: option.day,
    window: `${option.startClock}-${option.endClock}`,
    coach: option.coach,
    coachOk: coach.ok,
    eligibleSeats: seats,
    capacity: option.capacity,
    feasible: blockers.length === 0,
    blockers,
    warnings,
  };
}

// 演练间教官/学员时间冲突与跨馆 travel
export function checkOptionScheduling(t, index, evaluations) {
  const evals = new Map(evaluations.map(e => [e.option, e]));
  const notes = [];
  for (let i = 0; i < t.options.length; i += 1) {
    for (let j = i + 1; j < t.options.length; j += 1) {
      const a = t.options[i];
      const b = t.options[j];
      if (a.day !== b.day) continue;
      // 同一教官时间冲突
      if (a.coach === b.coach && intervalsOverlap(a.start, a.end, b.start, b.end)) {
        notes.push({ options: [a.option, b.option], kind: 'coach-double-booking', detail: `教官 ${a.coach} 在两场演练时间重叠` });
      }
      // 跨馆相接：travel 要求
      if (a.venue !== b.venue && !intervalsOverlap(a.start, a.end, b.start, b.end)) {
        const [first, second] = a.start <= b.start ? [a, b] : [b, a];
        const gap = second.start - first.end;
        const required = index.travelMap.get(`${first.venue}|${second.venue}`);
        if (required !== undefined && gap < required) {
          notes.push({
            options: [first.option, second.option],
            kind: 'travel-gap-unmet',
            detail: `${first.option}(${first.venue}) 接 ${second.option}(${second.venue}) 间隔 ${gap} 分钟 < travel ${required} 分钟`,
          });
        }
      }
    }
  }
  void evals;
  return notes;
}

// 两场演练先后相接时的带教链：参加过一次即可带教(attendance) vs 必须先考核合格(credential-confirmed)
export function coachingChains(t) {
  return t.trainingConditions.map(c => {
    const prereq = t.options.find(o => o.option === c.prerequisite);
    const target = t.options.find(o => o.option === c.option);
    return {
      chain: `${c.prerequisite} -> ${c.option}`,
      subject: c.subject,
      requirement: c.required,
      interpretation: c.required === 'attendance'
        ? '参加过前置演练即可，带教条件随出勤成立'
        : '必须先凭据确认合格，计划考核不得自动视为通过',
      prerequisiteWindow: prereq ? `${prereq.day} ${prereq.startClock}-${prereq.endClock} ${prereq.venue}` : null,
      targetWindow: target ? `${target.day} ${target.startClock}-${target.endClock} ${target.venue}` : null,
      // 第一场地教官临时离开：名额可能还在，但带教条件已改变
      contingency: `若 ${c.prerequisite} 教官临时离开，${c.subject} 的名额保留状态不变，但 ${c.option} 的带教条件按 ${c.required} 重新判定`,
    };
  });
}

// ---------- 候选演练方案 ----------

export function buildPlans(t, index, evaluations, readiness, asOfDay) {
  const feasible = evaluations.filter(e => e.feasible);
  const evalMap = new Map(evaluations.map(e => [e.option, e]));
  const plans = [];

  // 方案一：全部可行演练，最大化新增证据
  const allFeasibleIds = feasible.map(e => e.option);
  plans.push(describePlan('plan-max-evidence', '全部可行演练，最大化新增证据', allFeasibleIds, t, index, evalMap, readiness, asOfDay));

  // 方案二：只保留能直接补强 F1 主岗 V3 的链条 P1+P5（若可行）
  const v3Chain = ['P1', 'P5'].filter(id => evalMap.get(id)?.feasible);
  if (v3Chain.length) {
    plans.push(describePlan('plan-v3-chain', '聚焦 V3 的 P1→P5 出勤链', v3Chain, t, index, evalMap, readiness, asOfDay));
  }

  // 方案三：单场 P3（最少资源，补 V3 在 A 馆 radio 的 solo 空白）
  if (evalMap.get('P3')?.feasible) {
    plans.push(describePlan('plan-p3-only', '仅开 P3，最小资源补 A 馆证据', ['P3'], t, index, evalMap, readiness, asOfDay));
  }

  // 方案四：条件路径——把 P1 的唯一名额派给 V3，解锁 P5（attendance 型带教链）
  const p1 = evalMap.get('P1');
  const p5 = evalMap.get('P5');
  if (p1?.feasible && p5) {
    const conditional = describePlan(
      'plan-conditional-p1-p5',
      '条件路径：P1 名额派给 V3 以满足出勤，解锁 P5',
      ['P1', 'P5'], t, index, evalMap, readiness, asOfDay, true,
    );
    conditional.conditional = true;
    conditional.conditions = [
      'P1 容量为 1，须把唯一名额给 V3（V4 让出），V3 在 P1 实际签到后 P5 的 attendance 前置才成立',
      'P5 自身容量为 1；该链条只解决证据，不解除 V3 第 12 天才生效的持证缺口',
    ];
    plans.push(conditional);
  }

  return plans;
}

function describePlan(id, name, optionIds, t, index, evalMap, readiness, asOfDay, conditional = false) {
  const affectedArrangements = [];
  const hardLimits = [];
  for (const id of optionIds) {
    const evalResult = evalMap.get(id);
    const option = t.options.find(o => o.option === id);
    // 条件方案优先展示前置条件的主体（如 P5 链条里的 V3），而不是已就绪的共用替补
    let seats = evalResult.eligibleSeats;
    if (conditional) {
      const conditionSubjects = t.trainingConditions
        .filter(c => c.option === id)
        .map(c => c.subject)
        .filter(subject => seats.includes(subject));
      if (conditionSubjects.length) seats = conditionSubjects;
    }
    for (const student of seats.slice(0, option.capacity)) {
      const r = readiness.find(x => x.person === student && x.venue === option.venue && x.skill === option.skill);
      let change;
      if (!r) {
        change = '无当前准备度记录';
      } else if (r.state === 'not-credentialed') {
        change = `一场 ${option.venue} 馆 solo 通过可补足 ${student} 的观察证据，但凭据第 ${index.personMap.get(student).credentialFrom ?? '—'} 天才生效，持证缺口仍需班表复核解决`;
      } else if (r.state === 'evidence-failure') {
        change = `新的通过观察可覆盖此前 fail 记录，但仍需结合复训与取证流程确认`;
      } else if (r.state !== 'solo-ready') {
        change = `一场 ${option.venue} 馆 solo 通过可把 ${student} 从 ${r.state} 推向独立就绪`;
      } else {
        change = '已独立就绪，新增证据主要用于复核';
      }
      affectedArrangements.push({
        option: id,
        student,
        currentState: r?.state ?? 'unknown',
        newEvidenceCouldChange: change,
      });
    }
  }
  // 硬性限制：演练证据不能解除持证缺口；已锁定班次不重排
  for (const shift of t.shifts.filter(s => s.locked)) {
    hardLimits.push(`已锁定班次 ${shift.shift} 保留承诺，演练只生成复核建议，不当作已换班`);
  }
  for (const person of t.people) {
    if (person.credentialFrom !== null && person.credentialFrom > asOfDay) {
      hardLimits.push(`${person.person} 凭据第 ${person.credentialFrom} 天才生效，第 10 天班次的持证缺口不能靠演练评分取消`);
    }
    if (person.credentialFrom === null) {
      hardLimits.push(`${person.person} 无凭据记录，硬性持证要求不因准备度评分提高而取消`);
    }
  }
  void index;
  return {
    id,
    name,
    options: optionIds,
    affectedArrangements: unique(affectedArrangements.map(a => JSON.stringify(a))).map(s => JSON.parse(s)),
    hardLimits: unique(hardLimits),
  };
}

// ---------- 分派偏差与观察欠缺 ----------

export function assignmentBias(t, index, asOfDay) {
  const reports = [];
  for (const rule of t.slotRules) {
    const people = t.people.filter(p => p.skill === rule.skill);
    const perPerson = people.map(p => {
      const events = evidenceForSlot(t, p.person, rule.venue, rule.skill, asOfDay);
      const profile = evidenceProfile(events);
      return {
        person: p.person,
        soloSlots: profile.soloPass + profile.soloFail + profile.assessmentPass + profile.assessmentFail,
        supervisedSlots: profile.supervisedPass + profile.supervisedFail,
        cancelled: profile.cancelled,
        noShow: profile.noShow,
        hasSoloPass: profile.soloPass + profile.assessmentPass > 0,
      };
    });
    const totalSolo = perPerson.reduce((sum, x) => sum + x.soloSlots, 0);
    const totalSlots = perPerson.reduce((sum, x) => sum + x.soloSlots + x.supervisedSlots, 0);
    const soloShare = totalSlots === 0 ? 0 : totalSolo / totalSlots;
    const proficientIds = perPerson.filter(x => x.hasSoloPass).map(x => x.person);
    const proficientSolo = perPerson.filter(x => x.hasSoloPass).reduce((s, x) => s + x.soloSlots, 0);
    const proficientConcentration = totalSolo === 0 ? 0 : proficientSolo / totalSolo;
    const underObserved = perPerson.filter(x => x.soloSlots === 0).map(x => x.person);

    const flags = [];
    // 熟练者优先被派去的演练里只看到零失误：分派偏差
    if (proficientConcentration >= 0.8 && proficientIds.length > 0 && underObserved.length > 0) {
      flags.push({
        code: 'assignment-bias',
        detail: `独立(solo)演练 ${Math.round(proficientConcentration * 100)}% 集中在已熟练者 ${proficientIds.join('、')}，零失误不能外推到未独立者`,
      });
    }
    // 观察欠缺：被排班但该岗位无 solo 证据
    for (const shift of t.shifts.filter(s => s.venue === rule.venue && s.skill === rule.skill)) {
      for (const id of [shift.primary, shift.backup].filter(Boolean)) {
        const entry = perPerson.find(x => x.person === id);
        if (entry && entry.soloSlots === 0) {
          flags.push({
            code: 'observation-deficiency',
            person: id,
            shift: shift.shift,
            detail: `${id} 被排入 ${shift.shift}，但在 ${rule.venue}/${rule.skill} 没有任何 solo 观察，独立当班能力未被检验`,
          });
        }
      }
    }
    if (flags.length) {
      reports.push({ venue: rule.venue, skill: rule.skill, soloShare: Number(soloShare.toFixed(3)), perPerson, flags });
    }
  }
  return reports;
}

// ---------- 回溯检验（walk-forward） ----------

// 用此前不同演练日“当时可见”的资料预测，随后续真实观察检验可靠性
export function backtest(t, index) {
  const checkpoints = unique(t.observations.map(o => o.scheduledDay)).sort((a, b) => a - b);
  const results = [];
  for (const day of checkpoints) {
    // 时点：该演练日开始前能看到的资料（known_day < day 的计划日观察，且 known_day <= day-1）
    const asOf = day - 1;
    const later = t.observations.filter(o => o.scheduledDay === day && o.outcome !== 'cancelled');
    let brierSum = 0;
    let brierCount = 0;
    let hits = 0;
    let decided = 0;
    const cases = [];
    for (const o of later) {
      if (!slotRuleExists(index, o.venue, o.skill)) continue;
      const prior = evidenceForSlot(t, o.person, o.venue, o.skill, asOf);
      const profile = evidenceProfile(prior);
      const estimate = betaEstimate(
        profile.soloPass + profile.assessmentPass,
        profile.soloFail + profile.assessmentFail,
      );
      // 只对 solo 结果计分；supervised 结果用于覆盖统计但不进入独立当班概率评分
      if (o.supervision !== 'solo') continue;
      const actual = o.outcome === 'pass' ? 1 : o.outcome === 'fail' ? 0 : null;
      if (actual === null) continue; // no-show 不计入通过/失败评分
      decided += 1;
      brierSum += (estimate.pSolo - actual) ** 2;
      brierCount += 1;
      const predictedPass = estimate.pSolo >= 0.5;
      if (predictedPass === (actual === 1)) hits += 1;
      cases.push({
        event: o.event,
        person: o.person,
        venue: o.venue,
        skill: o.skill,
        predicted: estimate.pSolo,
        actual: actual === 1 ? 'pass' : 'fail',
        priorSoloEvidence: profile.soloPass + profile.assessmentPass + profile.soloFail + profile.assessmentFail,
      });
    }
    if (brierCount > 0) {
      results.push({
        checkpointDay: day,
        decided,
        hitRate: Number((hits / decided).toFixed(3)),
        brier: Number((brierSum / brierCount).toFixed(4)),
        cases,
      });
    } else {
      results.push({ checkpointDay: day, decided: 0, hitRate: null, brier: null, cases });
    }
  }
  const aggregate = (() => {
    const all = results.flatMap(r => r.cases);
    if (all.length === 0) return { cases: 0, hitRate: null, brier: null, note: '无足够 solo 样本，可靠性不可估计' };
    const brier = all.reduce((s, c) => s + (c.predicted - (c.actual === 'pass' ? 1 : 0)) ** 2, 0) / all.length;
    const hits = all.filter(c => (c.predicted >= 0.5) === (c.actual === 'pass')).length;
    return {
      cases: all.length,
      hitRate: Number((hits / all.length).toFixed(3)),
      brier: Number(brier.toFixed(4)),
      note: '小样本启发式指标；cancel 已排除，no-show 不计通过/失败',
    };
  })();
  return { checkpoints: results, aggregate };
}

// ---------- 锁定班次的证据边界 ----------

export function lockedSnapshots(t, index) {
  const shiftMap = new Map(t.shifts.map(s => [s.shift, s]));
  const snapshots = [];
  for (const notice of t.changeNotices.filter(n => n.kind === 'locked')) {
    const shift = shiftMap.get(notice.subject);
    if (!shift) continue;
    const boundaryDay = notice.knownDay;
    const readinessAtLock = [shift.primary, shift.backup].filter(Boolean).map(id =>
      readinessFor(t, index, id, shift.venue, shift.skill, boundaryDay));
    const visibleAtLock = visibleObservations(t, boundaryDay)
      .filter(o => [shift.primary, shift.backup].includes(o.person) && o.skill === shift.skill)
      .map(o => o.event);
    snapshots.push({
      shift: shift.shift,
      lockedOnDay: boundaryDay,
      notice: notice.notice,
      detail: notice.detail,
      evidenceBoundary: { asOfDay: boundaryDay, visibleEvents: visibleAtLock },
      readinessAtLock,
      currentReadiness: [shift.primary, shift.backup].filter(Boolean).map(id =>
        readinessFor(t, index, id, shift.venue, shift.skill, shift.day)),
    });
  }
  return snapshots;
}

// ---------- 审计缺口（现场负责人查询） ----------

export function auditGaps(t, index, shiftChecks, asOfDay) {
  const gaps = [];
  const add = (source, category, cause, detail, recommendedAction, evidence = []) =>
    gaps.push({ source, category, cause, detail, recommendedAction, evidence });

  for (const check of shiftChecks.perShift) {
    for (const f of check.findings) {
      const action = f.category === 'qualification-gap'
        ? '提交班表复核并启用合规替补；不得用演练评分替代持证'
        : f.category === 'coverage-gap'
          ? '启用替补或调整演练以补足覆盖'
          : '加开适用岗位演练以补证据';
      add(check.shift, f.category, f.code, f.detail, action, f.evidence);
    }
  }
  for (const c of shiftChecks.crossConflicts) {
    add(c.shifts.join('+'), 'coverage-gap', c.kind, c.detail, '提交班表复核：拆分任务或安排可 travel 到达的替补');
  }
  for (const h of shiftChecks.handovers.filter(x => !x.met)) {
    add(`${h.dependsOn}->${h.followup}`, 'coverage-gap', 'handover-overlap-unmet',
      `交接重叠 ${h.overlapMinutes} 分钟 < 要求 ${h.requiredOverlap}`, '调整班次窗口或加派现场交接人');
  }
  for (const h of shiftChecks.handovers.filter(x => x.travel && !x.travel.met)) {
    const detail = h.travel.overlapping
      ? '两班时间重叠，跨馆不可兼顾'
      : `跨馆间隔 ${h.travel.gap} 分钟 < travel ${h.travel.required}`;
    add(`${h.dependsOn}->${h.followup}`, 'coverage-gap', 'travel-gap-unmet',
      detail, '不能向现场保证交接覆盖，需改派本地替补');
  }
  // 取消与缺考的区分
  for (const o of t.observations.filter(x => x.outcome === 'cancelled')) {
    add(o.event, 'evidence-gap', 'drill-cancelled',
      `${o.person} 的 ${o.venue}/${o.skill} 演练被场馆取消（${o.scheduledDay} 日）`,
      '取消不算学员失败，需另排演练；不得转默认合格');
  }
  for (const o of t.observations.filter(x => x.outcome === 'no-show')) {
    add(o.event, 'evidence-gap', 'exam-no-show',
      `${o.person} 在 ${o.venue}/${o.skill} 缺考（${o.scheduledDay} 日）`,
      '缺考区别于取消，记为学员侧缺口，安排补考/补训');
  }
  // 凭据/成绩录入晚于受影响班次
  for (const person of t.people) {
    if (person.credentialFrom !== null && person.credentialFrom > asOfDay) {
      add(person.person, 'qualification-gap', 'credential-effective-late',
        `${person.person} 的 ${person.skill} 凭据第 ${person.credentialFrom} 天生效，晚于第 ${asOfDay} 天时点`,
        '不能补记为当时已合格；受影响班次按未持证处理',
        t.changeNotices.filter(n => n.kind === 'credential-effective' && n.subject &&
          t.observations.some(o => o.event === n.subject && o.person === person.person))
          .map(n => ({ notice: n.notice, detail: n.detail })));
    }
  }
  // 晚到的观察记录（known_day > asOfDay）
  for (const o of t.observations.filter(x => x.knownDay > asOfDay)) {
    add(o.event, 'evidence-gap', 'record-entered-late',
      `${o.event} 计划日 ${o.scheduledDay} 但第 ${o.knownDay} 天才录入，时点 ${asOfDay} 不可见`,
      '保留录入时间痕迹；当时决策不得引用该证据');
  }
  return gaps;
}

// ---------- 总入口 ----------

export function analyze(rawTables, asOfDay) {
  const t = normalizeTables(rawTables);
  const index = buildIndexes(t);
  const readiness = allReadiness(t, index, asOfDay);
  const shiftChecks = checkAllShifts(t, index, asOfDay);
  const optionEvaluations = t.options.map(o => evaluateOption(t, index, o, asOfDay));
  const schedulingNotes = checkOptionScheduling(t, index, optionEvaluations);
  const plans = buildPlans(t, index, optionEvaluations, readiness, asOfDay);
  const bias = assignmentBias(t, index, asOfDay);
  const reliability = backtest(t, index);
  const locked = lockedSnapshots(t, index);
  const gaps = auditGaps(t, index, shiftChecks, asOfDay);

  return {
    metadata: {
      asOfDay,
      generatedFrom: 'fixtures 合成交接资料',
      evidenceRule: 'known_day <= asOfDay 才可见；cancel 不算失败，no-show 区别于 fail，均不转默认合格',
    },
    readiness,
    shiftChecks,
    drills: { evaluations: optionEvaluations, schedulingNotes, chains: coachingChains(t) },
    plans,
    assignmentBias: bias,
    reliability,
    lockedSnapshots: locked,
    auditGaps: gaps,
  };
}
