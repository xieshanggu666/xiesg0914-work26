/* freshkeeper/test/staple.test.js —— 常备食材预警：常备数量 / 自动生成待购（建议购买量）/ 买到解除 / 流水 */
const test = require('node:test');
const assert = require('node:assert');
const Storage = require('../js/storage');

function memBackend() {
  let s = {};
  return {
    getItem: k => (s[k] === undefined ? null : s[k]),
    setItem: (k, v) => { s[k] = String(v); },
    _raw: () => s['freshkeeper:v1']
  };
}

const EGG = { name: '鸡蛋', categoryId: 'egg', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' };
const MILK = { name: '牛奶', categoryId: 'milk', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' };

function addEggs(st, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(st.addItem(EGG));
  return out;
}

test('设置常备：默认字段与校验（名称必填、数量 1–99、同名拒绝）', () => {
  const st = Storage.createStore(memBackend());
  const s = st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 2, note: '要土鸡蛋' });
  assert.equal(s.minQty, 2);
  assert.equal(s.note, '要土鸡蛋');
  assert.equal(st.listStaples().length, 1);
  assert.throws(() => st.addStaple({ name: '  ', minQty: 1 }), /名称不能为空/);
  assert.throws(() => st.addStaple({ name: '牛奶', minQty: 0 }), /1–99/);
  assert.throws(() => st.addStaple({ name: '牛奶', minQty: 100 }), /1–99/);
  assert.throws(() => st.addStaple({ name: '牛奶', minQty: '很多' }), /1–99/);
  // 归一化同名（去空白、转小写）拒绝
  assert.throws(() => st.addStaple({ name: ' 鸡蛋 ', minQty: 1 }), /同名/);
  // 数量允许字符串数字并向下取整
  const s2 = st.addStaple({ name: '牛奶', minQty: '3' });
  assert.equal(s2.minQty, 3);
});

test('在库低于常备数量：自动生成待购项并带建议购买量，写入流水', () => {
  const st = Storage.createStore(memBackend());
  addEggs(st, 1);
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 3 });
  const open = st.listShopping('open');
  assert.equal(open.length, 1, '应自动生成 1 条待购');
  const sh = open[0];
  assert.equal(sh.name, '鸡蛋');
  assert.equal(sh.source, 'staple');
  assert.equal(sh.stapleId, st.listStaples()[0].id);
  assert.equal(sh.status, 'unclaimed');
  assert.equal(sh.qty, '2 份', '建议购买量 = 常备 3 − 在库 1');
  const alert = st.auditEntries().find(e => e.action === 'staple.alert');
  assert.ok(alert, '生成待购应写 staple.alert 流水');
  assert.equal(alert.detail.inStock, 1);
  assert.equal(alert.detail.minQty, 3);
  assert.equal(alert.detail.suggestedQty, 2);
  assert.equal(alert.detail.shoppingId, sh.id);
  // 设置本身也入流水
  assert.ok(st.auditEntries().some(e => e.action === 'staple.add'));
});

test('库存变动持续低于常备线：不重复生成待购（已有自动项覆盖）', () => {
  const st = Storage.createStore(memBackend());
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 2 });
  assert.equal(st.listShopping('open').length, 1);
  // 再发生多次库存变动（加入其它食材、记录事件），仍只有 1 条自动待购
  st.addItem(MILK);
  const egg2 = st.addItem(EGG); // 在库 1，仍 < 2
  st.addEvent(egg2.id, 'open', { at: '2026-09-11' });
  assert.equal(st.listShopping('open').length, 1);
  assert.equal(st.auditEntries().filter(e => e.action === 'staple.alert').length, 1);
});

test('已有同名开口待购（手动/补货）视为已覆盖，不再自动生成', () => {
  const st = Storage.createStore(memBackend());
  st.addShopping({ name: '鸡蛋', qty: '1 板' }); // 手动待购先存在
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 2 });
  assert.equal(st.listShopping('open').length, 1, '不应重复生成');
  assert.equal(st.listShopping('open')[0].source, 'manual');
  assert.equal(st.auditEntries().filter(e => e.action === 'staple.alert').length, 0);
});

test('在库变化时自动待购的建议购买量随之重算（bug：照旧数量会买多）', () => {
  const st = Storage.createStore(memBackend());
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 5 });
  const auto = st.listShopping('open')[0];
  assert.equal(auto.qty, '5 份', '在库 0 时建议买 5 份');
  // 手动录入 3 份（不经待购流程）：缺口 5→2，待购数量必须跟着改
  addEggs(st, 3);
  assert.equal(st.getShopping(auto.id).qty, '2 份', '在库 3 后建议量应重算为 2 份');
  assert.equal(st.listShopping('open').length, 1, '仍是同一条待购，不新建');
  // 吃掉 1 份：缺口回到 3
  const egg = st.listItems().filter(i => i.name === '鸡蛋')[0];
  st.addEvent(egg.id, 'consume', { at: '2026-09-14' });
  assert.equal(st.getShopping(auto.id).qty, '3 份', '消耗后建议量应回升');
  // 重算全程写流水：三次录入各重算一次（5→4→3→2 份），消耗后再重算一次（2→3 份）
  const upds = st.auditEntries().filter(e => e.action === 'staple.alert.update');
  assert.equal(upds.length, 4, '每次在库变动都应重算建议量');
  // 流水倒序（最新在前）
  assert.equal(upds[0].detail.qtyFrom, '2 份');
  assert.equal(upds[0].detail.qtyTo, '3 份');
  assert.equal(upds[0].detail.inStock, 2);
  assert.equal(upds[0].detail.shoppingId, auto.id);
  assert.equal(upds[1].detail.qtyFrom, '3 份');
  assert.equal(upds[1].detail.qtyTo, '2 份');
  assert.equal(upds[1].detail.inStock, 3);
  assert.equal(upds[1].detail.minQty, 5);
  assert.equal(upds[3].detail.qtyFrom, '5 份');
  assert.equal(upds[3].detail.qtyTo, '4 份');
  assert.equal(upds[3].detail.inStock, 1);
});

test('已认领的自动待购同样重算建议量，认领状态不受影响；数量不变不写流水', () => {
  const st = Storage.createStore(memBackend());
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 3 });
  const auto = st.listShopping('open')[0];
  st.claimShopping(auto.id, '妈妈');
  addEggs(st, 1); // 缺口 3→2
  const now = st.getShopping(auto.id);
  assert.equal(now.qty, '2 份');
  assert.equal(now.status, 'claimed');
  assert.equal(now.assignee, '妈妈', '重算只改数量，不动负责人');
  // 与缺口无关的库存变动：数量不变，不应产生新的重算流水
  st.addItem(MILK);
  assert.equal(st.auditEntries().filter(e => e.action === 'staple.alert.update').length, 1);
});

test('覆盖预警的手动待购项数量不被系统改写', () => {
  const st = Storage.createStore(memBackend());
  st.addShopping({ name: '鸡蛋', qty: '10 斤' }); // 用户自己填的数量
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 5 });
  addEggs(st, 3);
  assert.equal(st.listShopping('open').length, 1, '手动待购覆盖，不生成自动项');
  assert.equal(st.listShopping('open')[0].qty, '10 斤', '手动待购保持用户填写');
  assert.equal(st.auditEntries().filter(e => e.action === 'staple.alert.update').length, 0);
});

test('吃到低于常备线：吃完事件触发自动生成待购', () => {
  const st = Storage.createStore(memBackend());
  const eggs = addEggs(st, 2);
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 2 });
  assert.equal(st.listShopping('open').length, 0, '在库 2 = 常备 2，不预警');
  st.addEvent(eggs[0].id, 'consume', { at: '2026-09-12' });
  const open = st.listShopping('open');
  assert.equal(open.length, 1, '在库降为 1 < 2，自动生成待购');
  assert.equal(open[0].qty, '1 份');
});

test('买到并录入到常备线：预警自动解除，自动待购项撤下并写解除流水', () => {
  const st = Storage.createStore(memBackend());
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 2 });
  const autoId = st.listShopping('open')[0].id;
  // 模拟“已买到 → 录入库存”：先录入 2 份（addItem 内重估），库存达标后自动待购被撤下
  addEggs(st, 2);
  assert.equal(st.listShopping('open').length, 0, '库存达常备线，自动待购应撤下');
  assert.equal(st.getShopping(autoId), null);
  const resolve = st.auditEntries().find(e => e.action === 'staple.resolve');
  assert.ok(resolve, '解除应写 staple.resolve 流水');
  assert.equal(resolve.detail.shoppingId, autoId);
  assert.equal(resolve.detail.inStock, 2);
  // 状态查询：充足
  const stt = st.listStapleStatus()[0];
  assert.equal(stt.below, false);
  assert.equal(stt.inStock, 2);
});

test('购买流程：买不够时完成待购后立即重新生成新预警待购', () => {
  const st = Storage.createStore(memBackend());
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 3 });
  const auto = st.listShopping('open')[0];
  assert.equal(auto.qty, '3 份');
  // 只买回 1 份：录入后在库 1 < 3，completeShopping 完成旧项 → 重新生成新预警
  const it = st.addItem(EGG);
  assert.equal(st.completeShopping(auto.id, it.id), true);
  assert.equal(st.getShopping(auto.id).status, 'done');
  const open = st.listShopping('open');
  assert.equal(open.length, 1, '仍低于常备线，应重新生成');
  assert.notEqual(open[0].id, auto.id);
  assert.equal(open[0].qty, '2 份', '新建议购买量 = 3 − 1');
});

test('购买流程：买够时 addItem 重估先解除预警，completeShopping 幂等返回 false', () => {
  const st = Storage.createStore(memBackend());
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 1 });
  const auto = st.listShopping('open')[0];
  const it = st.addItem(EGG); // 在库 1 = 常备 1 → 预警解除、自动项撤下
  assert.equal(st.getShopping(auto.id), null);
  assert.equal(st.completeShopping(auto.id, it.id), false, '待购已撤下，完成幂等');
  assert.equal(st.listShopping('open').length, 0);
});

test('撤销吃完事件让在库回升：预警同样自动解除', () => {
  const st = Storage.createStore(memBackend());
  const eggs = addEggs(st, 2);
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 2 });
  const ev = st.addEvent(eggs[0].id, 'consume', { at: '2026-09-12' });
  assert.equal(st.listShopping('open').length, 1);
  st.undoEvent(ev.id);
  assert.equal(st.listShopping('open').length, 0, '撤销吃完后在库回升，预警解除');
  assert.ok(st.auditEntries().some(e => e.action === 'staple.resolve'));
});

test('软删除/恢复食材也参与在库计数与预警联动', () => {
  const st = Storage.createStore(memBackend());
  const eggs = addEggs(st, 1);
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 1 });
  assert.equal(st.listShopping('open').length, 0);
  st.removeItem(eggs[0].id);
  assert.equal(st.listShopping('open').length, 1, '删除后在库 0，触发预警');
  st.restoreItem(eggs[0].id);
  assert.equal(st.listShopping('open').length, 0, '恢复后预警解除');
});

test('冷冻中的食材计入在库；已归档（吃完/丢弃）不计入', () => {
  const st = Storage.createStore(memBackend());
  st.addItem({ name: '鸡蛋', categoryId: 'egg', purchaseDate: '2026-09-01', packageType: 'sealed', location: 'pantry' });
  const ended = st.addItem(EGG);
  st.addEvent(ended.id, 'discard', { at: '2026-09-11', reason: '坏了' });
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 2 });
  const stt = st.listStapleStatus()[0];
  assert.equal(stt.inStock, 1, '已丢弃的不计入在库');
  assert.equal(stt.below, true);
});

test('同名匹配与待购同名比对同口径：去空白转小写', () => {
  const st = Storage.createStore(memBackend());
  st.addItem({ name: ' 鸡蛋 ', categoryId: 'egg', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' });
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 1 });
  assert.equal(st.listStapleStatus()[0].inStock, 1);
  assert.equal(st.listShopping('open').length, 0);
});

test('修改常备：调高数量立即生成待购，调低立即解除；字段变化写流水', () => {
  const st = Storage.createStore(memBackend());
  addEggs(st, 2);
  const s = st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 2 });
  assert.equal(st.listShopping('open').length, 0);
  st.updateStaple(s.id, { minQty: 3 });
  assert.equal(st.listShopping('open').length, 1, '调高到 3 后在库 2 低于常备线');
  st.updateStaple(s.id, { minQty: 1 });
  assert.equal(st.listShopping('open').length, 0, '调低到 1 后预警解除');
  const upd = st.auditEntries().filter(e => e.action === 'staple.update');
  assert.equal(upd.length, 2);
  assert.deepEqual(upd[1].detail.changes.minQty, { from: 2, to: 3 });
  // 非法修改抛错且不落盘
  assert.throws(() => st.updateStaple(s.id, { minQty: 0 }), /1–99/);
  assert.equal(st.getStaple(s.id).minQty, 1);
});

test('删除常备：撤下待认领的自动待购，保留已认领/已购买的', () => {
  const st = Storage.createStore(memBackend());
  const s = st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 2 });
  const auto1 = st.listShopping('open')[0];
  st.claimShopping(auto1.id, '妈妈');
  // 再触发一条（先删掉旧的再造新的）：直接加第二条常备场景
  const s2 = st.addStaple({ name: '牛奶', categoryId: 'milk', minQty: 1 });
  const auto2 = st.listShopping('open').find(x => x.name === '牛奶');
  assert.ok(auto2 && auto2.status === 'unclaimed');
  st.removeStaple(s.id);
  assert.ok(st.getShopping(auto1.id), '已认领的自动待购保留');
  st.removeStaple(s2.id);
  assert.equal(st.getShopping(auto2.id), null, '待认领的自动待购随常备删除撤下');
  assert.equal(st.listStaples().length, 0);
  const rm = st.auditEntries().filter(e => e.action === 'staple.remove');
  assert.equal(rm.length, 2);
  assert.equal(rm[0].detail.withdrawnShopping, 1);
});

test('手动删除自动待购后，下次库存变动会重新生成（预警仍有效）', () => {
  const st = Storage.createStore(memBackend());
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 1 });
  const auto = st.listShopping('open')[0];
  st.removeShopping(auto.id); // 用户手动删掉提醒
  assert.equal(st.listShopping('open').length, 0);
  st.addItem(MILK); // 任意库存变动 → 重估 → 仍低于常备线 → 重新生成
  const open = st.listShopping('open');
  assert.equal(open.length, 1);
  assert.equal(open[0].source, 'staple');
});

test('listStapleStatus：在库数/建议购买量/覆盖待购随库存实时变化', () => {
  const st = Storage.createStore(memBackend());
  const eggs = addEggs(st, 1);
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 3 });
  let stt = st.listStapleStatus()[0];
  assert.equal(stt.inStock, 1);
  assert.equal(stt.below, true);
  assert.equal(stt.suggestedQty, 2);
  assert.ok(stt.coveredBy && stt.coveredBy.source === 'staple');
  assert.ok(stt.autoShoppingId);
  addEggs(st, 2);
  stt = st.listStapleStatus()[0];
  assert.equal(stt.below, false);
  assert.equal(stt.suggestedQty, 0);
  assert.equal(stt.coveredBy, null);
});

test('常备随导出/合并导入往返：设置保留，重复 ID 拒绝', () => {
  const st = Storage.createStore(memBackend());
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 2, note: '要土鸡蛋' });
  const text = st.exportJSON();

  const st2 = Storage.createStore(memBackend());
  const r = st2.importJSON(text, true);
  assert.equal(r.staples, 1);
  assert.equal(st2.listStaples()[0].minQty, 2);
  assert.equal(st2.listStaples()[0].note, '要土鸡蛋');
  assert.throws(() => st2.importJSON(text, true), /ID/);
});

test('导入 staples 畸形结构被严格拒绝，已有数据不变', () => {
  const st = Storage.createStore(memBackend());
  st.addStaple({ name: '原有常备', minQty: 1 });
  assert.throws(() => st.importJSON({ items: [], staples: 'not-array' }, true), /staples/);
  assert.throws(() => st.importJSON({ items: [], staples: [{ minQty: 2 }] }, true), /名称/);
  assert.throws(() => st.importJSON({ items: [], staples: [{ name: '坏数量', minQty: 0 }] }, true), /常备数量/);
  assert.equal(st.listStaples().length, 1);
});

test('导入后按导入内容重估预警：缺货的生成待购、充足的解除', () => {
  const st = Storage.createStore(memBackend());
  st.importJSON({
    items: [{ id: 'e1', name: '鸡蛋', categoryId: 'egg', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' }],
    staples: [
      { id: 'st1', name: '鸡蛋', categoryId: 'egg', minQty: 2 },
      { id: 'st2', name: '牛奶', categoryId: 'milk', minQty: 1 }
    ]
  }, false);
  const open = st.listShopping('open');
  assert.equal(open.length, 2, '鸡蛋在库 1<2、牛奶在库 0<1，各生成一条');
  assert.ok(open.every(s => s.source === 'staple'));
  // 覆盖导入一份充足数据：预警解除
  st.importJSON({
    items: [
      { id: 'e1', name: '鸡蛋', categoryId: 'egg', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' },
      { id: 'e2', name: '鸡蛋', categoryId: 'egg', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' },
      { id: 'm1', name: '牛奶', categoryId: 'milk', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' }
    ],
    staples: [
      { id: 'st1', name: '鸡蛋', categoryId: 'egg', minQty: 2 },
      { id: 'st2', name: '牛奶', categoryId: 'milk', minQty: 1 }
    ]
  }, false);
  assert.equal(st.listShopping('open').length, 0);
});

test('历史数据迁移：畸形常备宽松修复（缺数量补 1、超界截断、坏记录跳过）', () => {
  const b = memBackend();
  b.setItem('freshkeeper:v1', JSON.stringify({
    items: [],
    staples: [
      { id: 'st1', name: '鸡蛋' },                          // 缺 minQty → 1
      { id: 'st2', name: '牛奶', minQty: 500 },             // 超界 → 99
      { id: 'st3', name: '酸奶', minQty: '好多' },          // 非法 → 1
      { id: 'st4' },                                        // 缺名称 → 跳过
      '字符串'
    ],
    audit: []
  }));
  const st = Storage.createStore(b);
  const rows = st.listStaples();
  assert.equal(rows.length, 3);
  assert.equal(st.getStaple('st1').minQty, 1);
  assert.equal(st.getStaple('st2').minQty, 99);
  assert.equal(st.getStaple('st3').minQty, 1);
});

test('旧版本数据（无 staples 字段）加载为空数组，不报错', () => {
  const b = memBackend();
  b.setItem('freshkeeper:v1', JSON.stringify({ items: [], shopping: [], audit: [] }));
  const st = Storage.createStore(b);
  assert.deepEqual(st.listStaples(), []);
  assert.deepEqual(st.listStapleStatus(), []);
  // 旧数据里的待购项也不受影响
  st.addShopping({ name: '黄瓜' });
  assert.equal(st.listShopping('open').length, 1);
});

test('预警自动待购随导出保留 stapleId 关联', () => {
  const st = Storage.createStore(memBackend());
  st.addStaple({ name: '鸡蛋', categoryId: 'egg', minQty: 2 });
  const text = st.exportJSON();
  const st2 = Storage.createStore(memBackend());
  st2.importJSON(text, true);
  const open = st2.listShopping('open');
  assert.equal(open.length, 1);
  assert.equal(open[0].source, 'staple');
  assert.equal(open[0].stapleId, st.listStaples()[0].id);
  assert.equal(open[0].qty, '2 份');
});

test('storageInfo 报告常备食材占用与条数', () => {
  const st = Storage.createStore(memBackend());
  st.addStaple({ name: '鸡蛋', minQty: 1 });
  const info = st.storageInfo();
  assert.equal(info.counts.staples, 1);
  assert.ok(info.parts.staples > 0);
});
