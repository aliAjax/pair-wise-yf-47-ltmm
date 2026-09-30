// 合并内核语义测试：用 node 直接跑编译后的 store（内存版 localStorage）
import "./test-setup";
import { useIncidentStore, buildStationViews, buildPlanViews, STATION_CONTROL_ROLES, PLAN_APPROVER_ROLES } from "../store/incident";

let pass = 0;
let fail = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
};

const s = () => useIncidentStore.getState();
const find = (id: string) => s().serverStations.find((x) => x.id === id)!;
const reset = () => localStorage.removeItem("pair-wise-yf-47/incident-v2");

// 场景 1：双方改同一字段 → 保留两版、留待协调，现场值不被旧值覆盖
reset();
useIncidentStore.setState({
  online: true, role: "车站值班员", pendingOps: [], conflicts: [],
  serverStations: [{ id: "s1", name: "滨江站", section: "x", status: "封闭", passengerRisk: "高", note: "a", updatedAt: "2026-09-30T10:00:00.000Z" }],
  serverTimeline: [], serverApprovals: { p1: ["调度员"] },
  plans: [{ id: "p1", stations: ["滨江站"], vehicles: 1, interval: 5, operator: "东城公交", status: "待确认", approvals: [], note: "n" }]
});
s().setOnline(false);
const r1 = s().setStationStatus("s1", "恢复中");
assert(r1 === "ok", "车站值班员离线改状态入队成功");
assert(s().pendingOps.length === 1, "产生 1 条待同步操作");
const op = s().pendingOps[0];
assert(op.kind === "station" && op.role === "车站值班员" && op.baseline === "封闭", "操作带岗位与基线（封闭）");
assert(buildStationViews(s())[0].status === "恢复中", "离线后界面展示现场值（恢复中）");

// 联网一侧在弱网期间也改了同字段
s().simulateRemoteStation("s1", { status: "限流" });
assert(find("s1").status === "限流" && buildStationViews(s())[0].status === "恢复中", "服务端改为限流，但现场视图仍显示恢复中（未被顶掉）");

s().setOnline(true);
assert(s().conflicts.length === 1, "恢复联网：检出 1 个字段冲突，不静默覆盖");
assert(s().pendingOps.length === 1, "冲突操作保留在队列中等待协调");
const v1 = buildStationViews(s())[0];
assert(v1.markers.status.kind === "conflict", "字段被标记为待协调");
if (v1.markers.status.kind === "conflict") {
  assert(v1.markers.status.local.value === "恢复中" && v1.markers.status.remote.value === "限流", "两版均保留：现场=恢复中 / 中心=限流");
}
assert(v1.status === "恢复中", "协调前主视图保留现场版");

// 客服主管不能协调
s().setRole("客服主管");
const beforeConflicts = s().conflicts.length;
s().resolveConflict(s().conflicts[0].id, "remote");
assert(s().conflicts.length === beforeConflicts, "客服主管无法协调冲突（只读）");

// 调度员采用现场版
s().setRole("调度员");
s().resolveConflict(s().conflicts[0].id, "local");
assert(s().conflicts.length === 0, "采用现场版后冲突关闭");
assert(s().pendingOps.length === 0, "对应待同步操作出队");
assert(find("s1").status === "恢复中", "服务端收敛为现场版（恢复中）");
assert(s().serverTimeline[0].action === "协调车站字段冲突", "协调动作进入时间线");

// 场景 2：服务端未改 → 安全快进，不产生冲突
s().setOnline(false);
s().setRole("车站值班员");
s().setStationStatus("s1", "正常");
s().setOnline(true);
assert(s().conflicts.length === 0, "基线未变时快进合并不产生冲突");
assert(s().pendingOps.length === 0, "快进后队列清空（不是无脑清空，是合并后清空）");
assert(find("s1").status === "正常", "服务端已应用现场值（正常）");

// 场景 3：两边改成同一值 → 收敛，无冲突
s().setOnline(false);
s().setStationStatus("s1", "限流");
s().simulateRemoteStation("s1", { status: "限流" });
s().setOnline(true);
assert(s().conflicts.length === 0 && s().pendingOps.length === 0, "双方收敛到同一值：无冲突、操作出队");

// 场景 4：离线补时间线 → 恢复后追加，不被清空
s().setOnline(false);
const beforeTL = s().serverTimeline.length;
const tr = s().addTimeline({ actor: "车站值班员", action: "现场补充", detail: "排水作业完成", phase: "恢复" });
assert(tr === "ok" && s().pendingOps.length === 1, "离线补时间线进入待同步队列");
s().setOnline(true);
assert(s().serverTimeline.length === beforeTL + 1, "恢复联网后时间线条目被合并保留");
assert(s().serverTimeline.some((e) => e.detail === "排水作业完成"), "合并的就是现场补录内容");

// 场景 5：接驳计划双岗确认
assert(PLAN_APPROVER_ROLES.length === 2, "接驳计划确认需两个岗位");
s().setRole("客服主管");
assert(s().approvePlan("p1") === "denied", "客服主管确认被拒");
s().setRole("车站值班员");
assert(s().approvePlan("p1") === "denied", "车站值班员确认被拒（不在确认岗位）");
// 新建一份尚无任何确认的计划，验证单岗确认不生效
s().setRole("公交接驳负责人");
s().addPlan({ stations: ["东港站"], vehicles: 2, interval: 8, operator: "西城公交", note: "测试双岗" });
const p2 = s().plans[0].id;
s().submitPlan(p2);
s().setOnline(false);
assert(s().approvePlan(p2) === "ok", "公交接驳负责人离线确认入队");
{
  const pv = buildPlanViews(s()).find((p) => p.id === p2)!;
  assert(pv.viewStatus === "待确认", "仅一岗（含待同步）确认时仍为待确认");
  assert(pv.pendingApprovals.includes("公交接驳负责人"), "确认带待同步标记");
}
// p1 已有调度员确认，恢复后并集校验
s().setOnline(true);
{
  const pv = buildPlanViews(s()).find((p) => p.id === "p1")!;
  assert(pv.viewApprovals.includes("调度员") && !pv.viewApprovals.includes("公交接驳负责人"), "p1 恢复后仍仅调度员确认（待公交负责人）");
}
// 公交负责人在线确认 p1
assert(s().approvePlan("p1") === "ok", "公交负责人在线确认 p1");
{
  const pv = buildPlanViews(s()).find((p) => p.id === "p1")!;
  assert(pv.viewApprovals.includes("调度员") && pv.viewApprovals.includes("公交接驳负责人"), "确认按岗位取并集（调度员+公交负责人）");
  assert(pv.viewStatus === "已确认", "双岗齐备 → 已确认");
}
// p2：离线的公交确认已合并，调度员再在线确认 → 双岗齐备
s().setRole("调度员");
assert(s().approvePlan(p2) === "ok", "调度员在线确认 p2");
{
  const pv = buildPlanViews(s()).find((p) => p.id === p2)!;
  assert(pv.viewStatus === "已确认" && pv.pendingApprovals.length === 0, "离线确认与在线确认取并集后已确认，待同步标记消除");
}

// 场景 6：封闭车站岗位门禁
assert(JSON.stringify(STATION_CONTROL_ROLES) === JSON.stringify(["调度员", "车站值班员"]), "可变更车站状态的岗位只有调度员、车站值班员");
s().setRole("客服主管");
assert(s().setStationStatus("s1", "封闭") === "denied", "客服主管不能封闭车站");
s().setRole("公交接驳负责人");
assert(s().setStationStatus("s1", "封闭") === "denied", "公交接驳负责人不能封闭车站");
s().setRole("公交接驳负责人");
assert(s().addTimeline({ actor: "公交接驳负责人", action: "接驳进展", detail: "首班接驳车到场", phase: "接驳" }) === "ok", "公交接驳负责人可以补充处置时间线");

// 场景 7：后到旧快照不能覆盖新值
s().setRole("调度员");
s().setOnline(true);
s().setStationStatus("s1", "封闭"); // 更新 updatedAt
const newer = find("s1").updatedAt;
s().ingestServerStations([{ id: "s1", name: "滨江站", section: "x", status: "正常", passengerRisk: "高", note: "旧", updatedAt: "2020-01-01T00:00:00.000Z" }]);
assert(find("s1").status === "封闭" && find("s1").updatedAt === newer, "后到的旧值不会盖掉现场记录");
s().ingestServerStations([{ id: "s1", name: "滨江站", section: "x", status: "恢复中", passengerRisk: "高", note: "新", updatedAt: "2099-01-01T00:00:00.000Z" }]);
assert(find("s1").status === "恢复中", "更新的服务端快照可正常接收");

// 场景 8：在线时客服主管全部写操作只读
s().setRole("客服主管");
assert(s().setStationStatus("s1", "正常") === "denied", "在线时客服主管改状态同样被拒");
assert(s().addTimeline({ actor: "客服主管", action: "x", detail: "y", phase: "响应" }) === "denied", "客服主管不能补时间线");
assert(s().approvePlan("p1") === "denied", "客服主管不能确认计划");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
