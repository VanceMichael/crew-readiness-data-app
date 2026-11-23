# 志愿班组准备度与演练名额安排

业务资料均为合成记录。表头字段及跨表引用见 `fixtures/format.json`。

## 数据说明

日号和时钟为当地日期时间。排班起止为半开区间，交接重叠按分钟，备用资格满足被替岗位的技能且有效期覆盖整班。相同人员在同一时段只可占一个岗位或带教席。观察 outcome 为 pass、fail、cancelled 或 no-show。solo 和 supervised 分开解释。known_day 表明训练办何时收到记录，凭据日期取 people 的签发有效期，两者各自有意义。
可选演练可分别开办，人数不能超 capacity，且教官有相应技能资格和足额可用时间。已经发出的正式排班为 locked；调整只生成复核建议，不能当作已换班。
training-conditions 只约束所指场次，attendance 可由实际培训签到满足，credential-confirmed 必须有已取得且当日有效的凭据，不能把计划考核自动当作通过。travel 是场馆间空闲时间最低要求。

CSV 使用 UTF-8、逗号分隔，无引号与内嵌换行。未提供的字段是空字符串，作为关系值的 `-` 表示不适用。多值字段用竖线分隔，数值和日期单位见业务约定。

## 资料检查

使用 Node.js 22.23.4，依赖仅为 Node.js 标准库。运行 `npm ci --ignore-scripts --offline` 准备工作区。

运行 `npm run check:materials` 检查合成交接资料的字段与记录引用。运行 `npm test` 检查交接资料的读取和校验。

## 换班准备度分析

`tools/readiness-engine.mjs` 是纯函数引擎，`tools/readiness-report.mjs` 是每次换班后运行的 CLI：

```bash
npm run readiness -- --day 9          # 中文文本报告（默认取最大 known_day）
npm run readiness:json -- --day 7     # 完整 JSON，供现场系统对接
```

### 证据与时点

- 只有 `known_day <= asOfDay` 的观察可见；晚录入记录进审计缺口，不回补当时结论。
- 观察必须同时匹配岗位的技能和场馆才参与该岗位的准备度估计；场馆无对应 slot-rule 即不适用。
- 训练签到、考核(assessment)、有监督演练(supervised)、独立演练(solo) 分开解释：
  - solo/assessment 通过才支撑“独立当班”；supervised 通过只得到 `supervised-only`。
  - `cancelled` 是场馆侧取消，不算学员失败；`no-show` 是学员侧缺考，二者都不转默认合格。
- 准备度点估计用 Beta-伯努利 Laplace 平滑（只吃 solo 证据），对未独立当班者显式输出方差作为剩余不确定性。
- `backtest` 用此前各演练日当时可见资料做 walk-forward，命中率与 Brier 分数检验估计可靠性，cancel 排除、no-show 不计通过/失败。
- 熟练者独占 solo 机会时输出 `assignment-bias`，被排班但无 solo 证据者输出 `observation-deficiency`。

### 排班与硬性约束

- 凭据按 people 的签发有效期闭区间判断；成绩/凭据生效日晚于受影响班次不能补记为当时合格。
- 缺口分三类：`qualification-gap`（缺资格/持证）、`coverage-gap`（人数、重叠、travel）、`evidence-gap`（合规但证据不足）。
- 同一人时间重叠即双重排班；跨馆相接班次的空闲间隔须满足 travel 表，赶不到就不能保证交接覆盖。
- 硬性持证或在岗要求不会因准备度评分提高而取消；locked 班次只生成复核建议，不当作已换班。
- locked 班次通过 change-notices 封存锁定时点的证据边界，同时保留当前最新准备度，两者可同时查。

### 演练名额与带教链

- 教官须技能匹配、获场馆 coach_authority 认可且当日凭据有效；学员须在 eligible_people 内、时间可用且不超 capacity。
- training-conditions 只约束所指场次：`attendance` 可由前置场次实际签到满足（未发生时保留名额、条件可行）；`credential-confirmed` 必须当日已有有效凭据，计划考核不自动当通过。
- 两场相接演练区分“参加过一次即可带教”(attendance) 与“必须先考核合格”(credential-confirmed)；前置教官临时离开时名额保留但带教条件重新判定。
- 候选方案标明每场新增证据可能改变哪处安排，并单列演练无法解除的硬约束（持证缺口、locked 承诺）。
