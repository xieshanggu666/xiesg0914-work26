/* freshkeeper/test/mealplan.test.js —— 用餐计划闭环：创建/预计状态提示/完成写事件/审计/导入导出 */
const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../js/engine');
const Storage = require('../js/storage');

function memBackend() {
  let s = {};
  return {
    getItem: k => (s[k] === undefined ? null : s[k]),
    setItem: (k, v) => { s[k] = String(v); },
    _raw: () => s['freshkeeper:v1']
  };
}

const D = (offset) => Engine.isoDate(Engine.addDays('2026-09-13T12:00:00', offset));
const NOW = '2026-09-13T12:00:00';

const SPINACH = { name: '菠菜', categoryId: 'leafy', purchaseDate: D(-4), packageType: 'loose', location: 'fridge' };
const TOFU = { name: '豆腐', categoryId: 'tofu', purchaseDate: D(-2), packageType: 'opened', location: 'fridge' };
const SALMON = { name: '三文鱼', categoryId: 'seafood', purchaseDate: D(-2), packageType: 'sealed', location: 'freezer' };

// ---------- 引擎：计划日预计状态 → 调整提示 ----------
test('planAdjustment：计划日已过期 → 提示提前食用/改早/冷冻', () => {
  // 菠菜散装冷藏按 5 天计：D(-4) 购入 → D(+1) 到期；计划日 D(+4) 已过期 3 天
  const st = Storage.createStore(memBackend());
  const it = st.addItem(SPINACH);
  const a = Engine.assess(it, Engine.parseISODate(D(4)));
  assert.equal(a.status, 'expired');
  const adj = Engine.planAdjustment(a);
  assert.equal(adj.level, 'expired');
  assert.match(adj.text, /已过期 3 天/);
  assert.match(adj.text, /提前食用|改早/);
});

test('planAdjustment：计划日临期/尽快 → 对应级别提示', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem(SPINACH);
  // D(+1) 到期当天（低风险 danger 阈值 0 天）
  const danger = Engine.planAdjustment(Engine.assess(it, Engine.parseISODate(D(1))));
  assert.equal(danger.level, 'danger');
  // D(0) 剩 1 天 → warn
  const warn = Engine.planAdjustment(Engine.assess(it, Engine.parseISODate(D(0))));
  assert.equal(warn.level, 'warn');
  assert.match(warn.text, /剩 1 天/);
});

test('planAdjustment：冷冻中 → 解冻提醒；状态良好 → null', () => {
  const st = Storage.createStore(memBackend());
  const frozen = st.addItem(SALMON);
  const adjF = Engine.planAdjustment(Engine.assess(frozen, Engine.parseISODate(D(5))));
  assert.equal(adjF.level, 'frozen');
  assert.match(adjF.text, /解冻/);
  // 鸡蛋 30 天期限，计划日 D(+5) 仍新鲜
  const egg = st.addItem({ name: '鸡蛋', categoryId: 'egg', purchaseDate: D(-1), packageType: 'sealed', location: 'fridge' });
  assert.equal(Engine.planAdjustment(Engine.assess(egg, Engine.parseISODate(D(5)))), null);
});

test('planAdjustment：已归档食材 → 提示更换', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem(TOFU);
  st.addEvent(it.id, 'consume', { at: D(-1) });
  const adj = Engine.planAdjustment(Engine.assess(st.getItem(it.id), Engine.parseISODate(D(2))));
  assert.equal(adj.level, 'gone');
  assert.match(adj.text, /移除|更换/);
});

// ---------- 存储：创建与排序 ----------
test('新建用餐计划：默认 pending，快照食材 id+名称，写审计', () => {
  const st = Storage.createStore(memBackend());
  const a = st.addItem(SPINACH);
  const b = st.addItem(TOFU);
  const plan = st.addMealPlan({ name: '周五晚餐', date: D(2), items: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }] });
  assert.equal(plan.status, 'pending');
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].name, '菠菜');
  const entry = st.auditEntries().find(e => e.action === 'mealplan.add');
  assert.ok(entry, '创建计划入审计');
  assert.equal(entry.detail.date, D(2));
  assert.deepEqual(entry.detail.itemNames, ['菠菜', '豆腐']);
});

test('计划清单按日期排列：待用餐日期升序在前，已完成按完成时间倒序', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem(SPINACH);
  const mk = (name, date) => st.addMealPlan({ name, date, items: [{ id: it.id, name: it.name }] });
  const late = mk('后天的', D(2));
  const early = mk('明天的', D(1));
  const done = mk('已完成的', D(3));
  st.completeMealPlan(done.id, { [it.id]: 'skip' });
  const all = st.listMealPlans();
  assert.deepEqual(all.map(p => p.name), ['明天的', '后天的', '已完成的']);
  assert.equal(st.listMealPlans('pending').length, 2);
  assert.equal(st.listMealPlans('done')[0].id, done.id);
});

// ---------- 完成闭环 ----------
test('完成计划：逐样写入做熟/吃完/丢弃事件，计划状态与审计自动更新', () => {
  const st = Storage.createStore(memBackend());
  const a = st.addItem(SPINACH);
  const b = st.addItem(TOFU);
  const c = st.addItem(SALMON);
  const plan = st.addMealPlan({
    name: '周末晚餐', date: D(1),
    items: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }, { id: c.id, name: c.name }]
  });
  const ok = st.completeMealPlan(plan.id, { [a.id]: 'cook', [b.id]: 'consume', [c.id]: 'skip' });
  assert.equal(ok, true);
  // 计划状态
  assert.equal(st.getMealPlan(plan.id).status, 'done');
  assert.ok(st.getMealPlan(plan.id).doneAt);
  // 事件真实写入食材（沿用现有事件体系，可撤销）
  const evA = st.getItem(a.id).events.filter(e => !e.deleted);
  assert.equal(evA.length, 1);
  assert.equal(evA[0].type, 'cook');
  assert.equal(evA[0].source, 'mealplan:' + plan.id);
  assert.match(evA[0].reason, /周末晚餐/);
  const evB = st.getItem(b.id).events.filter(e => !e.deleted);
  assert.equal(evB[0].type, 'consume');
  // skip 的不写事件
  assert.equal(st.getItem(c.id).events.length, 0);
  // 引擎结论随事件更新：豆腐已归档、菠菜已做熟
  assert.equal(Engine.assess(st.getItem(b.id), NOW).status, 'consumed');
  assert.equal(Engine.assess(st.getItem(a.id), NOW).state.cooked, true);
  // 审计：事件 + 完成汇总
  const actions = st.auditEntries().map(e => e.action);
  assert.ok(actions.includes('event.add'));
  assert.ok(actions.includes('mealplan.complete'));
  const done = st.auditEntries().find(e => e.action === 'mealplan.complete');
  assert.deepEqual(done.detail.recorded.map(r => r.event), ['cook', 'consume']);
  // 不能重复完成
  assert.equal(st.completeMealPlan(plan.id, {}), false);
});

test('完成计划：已删除/已归档食材自动跳过，未知动作忽略', () => {
  const st = Storage.createStore(memBackend());
  const a = st.addItem(SPINACH);
  const b = st.addItem(TOFU);
  st.addEvent(b.id, 'discard', { at: D(-1) });  // 先归档
  st.removeItem(a.id);                            // 再软删除
  const plan = st.addMealPlan({ name: '测试', date: D(1), items: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }] });
  st.completeMealPlan(plan.id, { [a.id]: 'consume', [b.id]: 'consume' });
  assert.equal(st.getItem(a.id).events.length, 0, '已删除食材不写事件');
  assert.equal(st.getItem(b.id).events.filter(e => !e.deleted && e.type === 'consume').length, 0,
    '已归档食材由界面默认跳过；即便传入也只在存储层对删除做硬拦截');
  const done = st.auditEntries().find(e => e.action === 'mealplan.complete');
  assert.equal(done.detail.recorded.length, 0);
});

test('删除计划：removeMealPlan 写审计，不影响食材', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem(SPINACH);
  const plan = st.addMealPlan({ name: '要删的', date: D(1), items: [{ id: it.id, name: it.name }] });
  assert.equal(st.removeMealPlan(plan.id), true);
  assert.equal(st.getMealPlan(plan.id), null);
  assert.equal(st.removeMealPlan(plan.id), false);
  assert.ok(st.auditEntries().some(e => e.action === 'mealplan.remove'));
  assert.equal(st.listItems().length, 1, '食材库存不受影响');
});

// ---------- 编辑计划（改完仍是同一条计划，不用删掉重建） ----------
test('编辑计划：改名称/日期/食材后 id 与创建时间不变，审计记 from→to', () => {
  const st = Storage.createStore(memBackend());
  const a = st.addItem(SPINACH);
  const b = st.addItem(TOFU);
  const c = st.addItem(SALMON);
  const plan = st.addMealPlan({ name: '周五晚餐', date: D(2), items: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }] });
  const createdAt = plan.createdAt;

  const updated = st.updateMealPlan(plan.id, {
    name: '周六火锅', date: D(3),
    items: [{ id: a.id, name: a.name }, { id: c.id, name: c.name }]
  });
  assert.ok(updated, '编辑成功');
  assert.equal(updated.id, plan.id, '仍是同一条计划');
  assert.equal(updated.createdAt, createdAt, '创建时间不变');
  assert.equal(updated.status, 'pending', '状态仍是待用餐');
  assert.equal(st.getMealPlan(plan.id).name, '周六火锅');
  assert.equal(st.getMealPlan(plan.id).date, D(3));
  assert.deepEqual(st.getMealPlan(plan.id).items.map(pi => pi.id), [a.id, c.id]);

  const entry = st.auditEntries().find(e => e.action === 'mealplan.update');
  assert.ok(entry, '编辑入审计');
  assert.deepEqual(entry.detail.changes.name, { from: '周五晚餐', to: '周六火锅' });
  assert.deepEqual(entry.detail.changes.date, { from: D(2), to: D(3) });
  assert.deepEqual(entry.detail.changes.items.from, ['菠菜', '豆腐']);
  assert.deepEqual(entry.detail.changes.items.to, ['菠菜', '三文鱼']);
  assert.equal(st.listMealPlans().length, 1, '不产生新计划');
});

test('编辑计划：只改日期后清单按新日期重新排序', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem(SPINACH);
  const mk = (name, date) => st.addMealPlan({ name, date, items: [{ id: it.id, name: it.name }] });
  const p1 = mk('原计划后天的', D(2));
  mk('明天的', D(1));
  assert.deepEqual(st.listMealPlans('pending').map(p => p.name), ['明天的', '原计划后天的']);
  st.updateMealPlan(p1.id, { date: D(0) });
  assert.deepEqual(st.listMealPlans('pending').map(p => p.name), ['原计划后天的', '明天的'],
    '改早后排到最前');
});

test('编辑计划：无实际变更不写审计流水', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem(SPINACH);
  const plan = st.addMealPlan({ name: '不变', date: D(1), items: [{ id: it.id, name: it.name }] });
  const before = st.auditEntries().length;
  const same = st.updateMealPlan(plan.id, { name: '不变', date: D(1), items: [{ id: it.id, name: it.name }] });
  assert.ok(same, '幂等保存仍返回计划');
  assert.equal(st.auditEntries().length, before, '没有变更就不写流水');
});

test('编辑计划：已完成/不存在的计划拒绝编辑', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem(SPINACH);
  const plan = st.addMealPlan({ name: '已完成的', date: D(1), items: [{ id: it.id, name: it.name }] });
  st.completeMealPlan(plan.id, { [it.id]: 'consume' });
  assert.equal(st.updateMealPlan(plan.id, { name: '想改名' }), null, '已完成计划是历史记录，不可改');
  assert.equal(st.getMealPlan(plan.id).name, '已完成的');
  assert.equal(st.updateMealPlan('mp-不存在', { name: 'x' }), null, '不存在的计划返回 null');
  assert.equal(st.auditEntries().some(e => e.action === 'mealplan.update'), false, '拒绝时不写流水');
});

test('编辑计划：非法输入整体拒绝，原计划不变', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem(SPINACH);
  const plan = st.addMealPlan({ name: '原计划', date: D(1), items: [{ id: it.id, name: it.name }] });
  assert.equal(st.updateMealPlan(plan.id, { name: '   ' }), null, '空名称拒绝');
  assert.equal(st.updateMealPlan(plan.id, { date: '明天' }), null, '坏日期拒绝');
  assert.equal(st.updateMealPlan(plan.id, { items: [] }), null, '空食材拒绝');
  assert.equal(st.updateMealPlan(plan.id, { items: '菠菜' }), null, 'items 非数组拒绝');
  assert.equal(st.updateMealPlan(plan.id, { items: [{ name: '没id' }] }), null, '食材缺 id 拒绝');
  const cur = st.getMealPlan(plan.id);
  assert.equal(cur.name, '原计划');
  assert.equal(cur.date, D(1));
  assert.equal(cur.items.length, 1);
});

test('编辑计划：成员快照随编辑更新，已删除成员被过滤', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem(SPINACH);
  const m1 = st.addMember({ name: '妈妈' });
  const m2 = st.addMember({ name: '爸爸' });
  const plan = st.addMealPlan({ name: '家宴', date: D(1), items: [{ id: it.id, name: it.name }], members: [m1.id] });
  assert.equal(st.getMealPlan(plan.id).members.length, 1);

  st.removeMember(m2.id); // 先删掉爸爸，再把他加进计划也不生效
  const before = st.auditEntries().length;
  const updated = st.updateMealPlan(plan.id, { members: [m1.id, m2.id] });
  assert.deepEqual(updated.members.map(mb => mb.id), [m1.id], '已删除成员不进快照');
  assert.equal(st.auditEntries().length, before, '成员集合实际没变就不写流水');

  st.updateMealPlan(plan.id, { members: [] });
  assert.deepEqual(st.getMealPlan(plan.id).members, [], '可以清空就餐成员');
  const entry = st.auditEntries().find(e => e.action === 'mealplan.update');
  assert.deepEqual(entry.detail.changes.members, { from: ['妈妈'], to: [] }, '成员变更记名称快照');
});

test('编辑计划：冲突确认快照可更新，无冲突时清除', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem(SPINACH);
  const plan = st.addMealPlan({
    name: '海鲜局', date: D(1), items: [{ id: it.id, name: it.name }],
    diet: { blockers: ['妈妈：水产'], warnings: [] }
  });
  assert.ok(st.getMealPlan(plan.id).diet, '创建时带确认快照');

  const acked = st.updateMealPlan(plan.id, { diet: { blockers: [], warnings: ['爸爸：香菜'] } });
  assert.deepEqual(acked.diet.warnings, ['爸爸：香菜'], '快照随编辑更新');
  assert.ok(acked.diet.acknowledgedAt);

  const cleared = st.updateMealPlan(plan.id, { diet: null });
  assert.equal(cleared.diet, undefined, '编辑后无冲突则清除旧快照');
  const entry = st.auditEntries().find(e => e.action === 'mealplan.update' && e.detail.dietAck === null);
  assert.ok(entry, '清除快照也入审计');
});

// ---------- 导入导出 / 迁移 ----------
test('用餐计划随导出/合并导入往返；重复 ID 拒绝合并', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem(SPINACH);
  st.addMealPlan({ name: '周五晚餐', date: D(2), items: [{ id: it.id, name: it.name }] });
  const text = st.exportJSON();
  assert.ok(JSON.parse(text).mealPlans.length === 1);

  const st2 = Storage.createStore(memBackend());
  const r = st2.importJSON(text, true);
  assert.equal(r.mealPlans, 1);
  assert.equal(st2.listMealPlans('pending')[0].name, '周五晚餐');
  assert.throws(() => st2.importJSON(text, true), /ID/);
});

test('导入 mealPlans 畸形结构被严格拒绝，已有数据不变', () => {
  const st = Storage.createStore(memBackend());
  st.addMealPlan({ name: '原计划', date: D(1), items: [] });
  assert.throws(() => st.importJSON({ items: [], mealPlans: 'not-array' }, true), /mealPlans/);
  assert.throws(() => st.importJSON({ items: [], mealPlans: [{ date: D(1), items: [] }] }, true), /名称/);
  assert.throws(() => st.importJSON({ items: [], mealPlans: [{ name: '坏日期', date: '明天', items: [] }] }, true), /日期/);
  assert.throws(() => st.importJSON({ items: [], mealPlans: [{ name: '坏items', date: D(1), items: '菠菜' }] }, true), /items/);
  assert.throws(() => st.importJSON({ items: [], mealPlans: [{ name: '坏食材', date: D(1), items: [{ name: '没id' }] }] }, true), /id/);
  assert.equal(st.listMealPlans().length, 1, '全部拒绝后原计划不变');
});

test('加载历史脏数据：畸形计划宽松跳过/修复，合法计划保留', () => {
  const b = memBackend();
  b.setItem('freshkeeper:v1', JSON.stringify({
    items: [],
    mealPlans: [
      { id: 'm1', name: '好计划', date: '2026-09-15', items: [{ id: 'x', name: '菠菜' }], status: 'pending' },
      { id: 'm2', date: '2026-09-15' },                                  // 缺名称：跳过
      '字符串',
      { id: 'm4', name: '已完成缺时间', date: '2026-09-10', items: [], status: 'done' },
      { id: 'm5', name: '食材项畸形', date: '2026-09-10', items: [{ id: 'y' }, 'junk'] }
    ],
    audit: []
  }));
  const st = Storage.createStore(b);
  const rows = st.listMealPlans();
  assert.equal(rows.length, 3);
  const done = rows.find(r => r.id === 'm4');
  assert.equal(done.status, 'done');
  assert.ok(done.doneAt, '缺失的完成时间归一化');
  const m5 = rows.find(r => r.id === 'm5');
  assert.equal(m5.items.length, 1, '畸形食材项被剔除，合法的保留');
});

test('覆盖导入会同时替换用餐计划', () => {
  const st = Storage.createStore(memBackend());
  st.addMealPlan({ name: '本地计划', date: D(1), items: [] });
  st.importJSON({ items: [], mealPlans: [{ id: 'nm1', name: '新文件计划', date: D(2), items: [] }] }, false);
  assert.equal(st.listMealPlans().length, 1);
  assert.equal(st.listMealPlans()[0].name, '新文件计划');
});

test('旧版数据没有 mealPlans 字段：加载与导入都兼容为空', () => {
  const b = memBackend();
  b.setItem('freshkeeper:v1', JSON.stringify({ items: [], shopping: [], audit: [] }));
  const st = Storage.createStore(b);
  assert.deepEqual(st.listMealPlans(), []);
  const r = st.importJSON({ items: [] }, true);
  assert.equal(r.mealPlans, 0);
});
