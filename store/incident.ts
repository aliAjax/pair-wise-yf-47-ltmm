import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行";
export type StationField = "status" | "note";

/** 可变更车站状态（含封闭）的岗位 */
export const STATION_CONTROL_ROLES: Role[] = ["调度员", "车站值班员"];
/** 接驳计划确认岗位：必须双岗确认 */
export const PLAN_APPROVER_ROLES: Role[] = ["调度员", "公交接驳负责人"];

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Role;
  action: string;
  detail: string;
  phase: "发现" | "响应" | "接驳" | "恢复";
}

export interface Station {
  id: string;
  name: string;
  section: string;
  status: StationStatus;
  passengerRisk: "低" | "中" | "高";
  note: string;
  updatedAt: string;
}

export interface ShuttlePlan {
  id: string;
  stations: string[];
  vehicles: number;
  interval: number;
  operator: string;
  status: PlanStatus;
  approvals: string[];
  note: string;
}

/**
 * 断网期间的待同步操作：每条都带岗位（role）、基线（baseline，操作人最后看到的服务端值）
 * 与待同步标记（进入 pendingOps 即视为待同步）。
 */
export type PendingOp =
  | { id: string; kind: "station"; role: Role; time: string; stationId: string; stationName: string; field: StationField; baseline: string; value: string }
  | { id: string; kind: "timeline"; role: Role; time: string; entry: TimelineEntry }
  | { id: string; kind: "planApproval"; role: Role; time: string; planId: string; planLabel: string; baseline: Role[] };

/** 同一车站字段两边都改过：两版都保留，列入待协调，禁止静默覆盖 */
export interface FieldConflict {
  id: string;
  stationId: string;
  stationName: string;
  field: StationField;
  local: { value: string; role: Role; time: string };
  remote: { value: string; time: string };
  detectedAt: string;
}

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  /** 调度中心（服务端）车站快照，弱网时以此为缓存基线 */
  serverStations: Station[];
  /** 服务端时间线 */
  serverTimeline: TimelineEntry[];
  /** 服务端各计划的确认岗位集合 */
  serverApprovals: Record<string, Role[]>;
  plans: ShuttlePlan[];
  role: Role;
  online: boolean;
  pendingOps: PendingOp[];
  conflicts: FieldConflict[];
  lastSyncAt: string | null;
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  setStationStatus: (id: string, status: StationStatus, note?: string) => "ok" | "denied";
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time">) => "ok" | "denied";
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals">) => void;
  submitPlan: (id: string) => void;
  approvePlan: (id: string) => "ok" | "denied" | "duplicate" | "not-ready";
  executePlan: (id: string) => void;
  /** 恢复联网 / 人工触发：逐项合并待同步操作 */
  mergePending: () => { merged: number; conflicts: number };
  /** 协调冲突：选定现场版或调度中心版 */
  resolveConflict: (conflictId: string, choice: "local" | "remote") => void;
  /** 拉取到的服务端车站数据：只接受比本地新的快照，后到的旧值不得覆盖 */
  ingestServerStations: (remote: Station[]) => void;
  /** 模拟联网一侧（调度中心）在弱网期间改了车站，用于恢复后演示冲突双保留 */
  simulateRemoteStation: (id: string, patch: { status?: StationStatus; note?: string }) => void;
}

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心-滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now() },
  { id: "s2", name: "会展中心站", section: "会展-滨江", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now() },
  { id: "s3", name: "东港站", section: "滨江-东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now() }
];

const isRecovery = (value: string) => value === "正常" || value === "恢复中";

/** 由待同步操作生成对应的时间线条目（与合并入服务端后的 id 保持一致，天然去重） */
function timelineFromOp(op: PendingOp): TimelineEntry | null {
  if (op.kind === "timeline") return { ...op.entry };
  if (op.kind === "station") {
    return {
      id: `op:${op.id}`,
      time: op.time,
      actor: op.role,
      action: op.field === "status" ? "更新车站状态" : "更新现场说明",
      detail: `${op.stationName}：${op.baseline} → ${op.value}`,
      phase: isRecovery(op.value) ? "恢复" : "响应"
    };
  }
  return {
    id: `op:${op.id}`,
    time: op.time,
    actor: op.role,
    action: "确认接驳计划",
    detail: `${op.planLabel} 获 ${op.role} 确认`,
    phase: "接驳"
  };
}

function planApprovals(state: IncidentState, planId: string): Role[] {
  const roles = new Set<Role>(state.serverApprovals[planId] ?? []);
  state.pendingOps.forEach((op) => { if (op.kind === "planApproval" && op.planId === planId) roles.add(op.role); });
  return Array.from(roles);
}

function derivePlanStatus(plan: ShuttlePlan, approvals: Role[]): PlanStatus {
  if (plan.status === "草稿" || plan.status === "已执行") return plan.status;
  return PLAN_APPROVER_ROLES.every((role) => approvals.includes(role)) ? "已确认" : "待确认";
}

/**
 * 逐项合并内核：按时间先后处理每条待同步操作。
 * - 服务端值仍等于基线：直接快进合并；
 * - 服务端值已变（两边都改了同一字段）：两版都保留，登记待协调，绝不静默覆盖；
 * - 时间线按条目 id 去重追加，计划确认按岗位取并集。
 */
function reconcile(state: IncidentState, online: boolean = state.online): Partial<IncidentState> {
  if (!online || state.pendingOps.length === 0) return {};

  const serverStations = state.serverStations.map((station) => ({ ...station }));
  const serverTimeline = [...state.serverTimeline];
  const serverApprovals: Record<string, Role[]> = Object.fromEntries(
    Object.entries(state.serverApprovals).map(([key, roles]) => [key, [...roles]])
  );
  const conflicts = [...state.conflicts];
  const timelineIds = new Set(serverTimeline.map((entry) => entry.id));
  const remaining: PendingOp[] = [];
  let merged = 0;

  const pushTimeline = (entry: TimelineEntry) => {
    if (!timelineIds.has(entry.id)) { serverTimeline.push(entry); timelineIds.add(entry.id); }
  };

  for (const op of [...state.pendingOps].reverse()) {
    if (op.kind === "station") {
      const station = serverStations.find((item) => item.id === op.stationId);
      if (!station) { remaining.push(op); continue; }
      const serverValue = op.field === "status" ? station.status : station.note;
      const entry = timelineFromOp(op)!;

      if (serverValue === op.value) {
        // 两边收敛到同一值，无需协调
        pushTimeline(entry);
        merged += 1;
        continue;
      }
      if (serverValue === op.baseline) {
        // 服务端未动过该字段，安全快进
        if (op.field === "status") station.status = op.value as StationStatus;
        else station.note = op.value;
        station.updatedAt = op.time;
        pushTimeline(entry);
        merged += 1;
      } else {
        // 双方都改了：保留两版，留待人工协调
        const key = `${op.stationId}:${op.field}`;
        const existing = conflicts.find((conflict) => conflict.id === key || (`${conflict.stationId}:${conflict.field}` === key));
        if (existing) {
          existing.local = { value: op.value, role: op.role, time: op.time };
        } else {
          conflicts.push({
            id: newId(),
            stationId: op.stationId,
            stationName: op.stationName,
            field: op.field,
            local: { value: op.value, role: op.role, time: op.time },
            remote: { value: serverValue, time: station.updatedAt },
            detectedAt: now()
          });
        }
        remaining.push(op);
      }
    } else if (op.kind === "timeline") {
      pushTimeline({ ...op.entry });
      merged += 1;
    } else {
      const roles = serverApprovals[op.planId] ?? [];
      if (!roles.includes(op.role)) { roles.push(op.role); serverApprovals[op.planId] = roles; }
      pushTimeline(timelineFromOp(op)!);
      merged += 1;
    }
  }

  serverTimeline.sort((a, b) => b.time.localeCompare(a.time));
  return { serverStations, serverTimeline, serverApprovals, conflicts, pendingOps: remaining, lastSyncAt: now() };
}

export const useIncidentStore = create<IncidentState>()(persist((set, get) => ({
  incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
  serverStations: seedStations,
  serverTimeline: [
    { id: "e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
    { id: "e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
  ],
  serverApprovals: { p1: ["调度员"] },
  plans: [
    { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: ["调度员"], note: "优先疏运站外滞留乘客" }
  ],
  role: "调度员",
  online: true,
  pendingOps: [],
  conflicts: [],
  lastSyncAt: null,

  setRole: (role) => set({ role }),

  setOnline: (online) => set((state) => ({
    online,
    // 恢复联网：立即逐项合并；发现的冲突进入待协调列表
    ...(online && !state.online ? reconcile(state, true) : {})
  })),

  setStationStatus: (id, status, note) => {
    const state = get();
    if (!STATION_CONTROL_ROLES.includes(state.role)) return "denied";
    const station = state.serverStations.find((item) => item.id === id);
    if (!station) return "denied";

    if (state.online) {
      const serverStations = state.serverStations.map((item) => {
        if (item.id !== id) return item;
        return { ...item, status, note: note ?? item.note, updatedAt: now() };
      });
      const entry: TimelineEntry = { id: newId(), time: now(), actor: state.role, action: "更新车站状态", detail: `${station.name} → ${status}`, phase: isRecovery(status) ? "恢复" : "响应" };
      set({ serverStations, serverTimeline: [entry, ...state.serverTimeline] });
      return "ok";
    }

    // 弱网：生成/更新带岗位与基线的待同步操作（同字段多次修改只留最新值，基线保留首版）
    const pendingOps = [...state.pendingOps];
    const ensureOp = (field: StationField, value: string) => {
      const baseline = field === "status" ? station.status : station.note;
      if (value === baseline) return;
      const index = pendingOps.findIndex((op) => op.kind === "station" && op.stationId === id && op.field === field);
      if (index >= 0) {
        const old = pendingOps[index];
        if (old.kind === "station") pendingOps[index] = { ...old, value, role: state.role, time: now() };
      } else {
        pendingOps.unshift({ id: newId(), kind: "station", role: state.role, time: now(), stationId: id, stationName: station.name, field, baseline, value });
      }
    };
    ensureOp("status", status);
    if (note !== undefined) ensureOp("note", note);
    set({ pendingOps });
    return "ok";
  },

  addTimeline: (entry) => {
    const state = get();
    if (state.role === "客服主管") return "denied";
    const full: TimelineEntry = { ...entry, id: newId(), time: now() };
    if (state.online) {
      set({ serverTimeline: [full, ...state.serverTimeline] });
    } else {
      set({ pendingOps: [{ id: newId(), kind: "timeline", role: state.role, time: now(), entry: full }, ...state.pendingOps] });
    }
    return "ok";
  },

  addPlan: (plan) => set((state) => {
    if (state.role === "客服主管" || (state.role !== "调度员" && state.role !== "公交接驳负责人")) return {};
    return { plans: [{ ...plan, id: newId(), status: "草稿", approvals: [] }, ...state.plans] };
  }),

  submitPlan: (id) => set((state) => {
    if (state.role === "客服主管") return {};
    const plans = state.plans.map((plan) => plan.id === id ? { ...plan, status: "待确认" as PlanStatus } : plan);
    const target = state.plans.find((plan) => plan.id === id);
    const entry: TimelineEntry = { id: newId(), time: now(), actor: state.role, action: "提交接驳计划", detail: `计划 ${target?.stations.join(" → ") ?? id.slice(0, 6)} 等待跨岗位确认`, phase: "接驳" };
    if (state.online) return { plans, serverTimeline: [entry, ...state.serverTimeline] };
    return { plans, pendingOps: [{ id: newId(), kind: "timeline", role: state.role, time: now(), entry }, ...state.pendingOps] };
  }),

  approvePlan: (id) => {
    const state = get();
    if (!PLAN_APPROVER_ROLES.includes(state.role)) return "denied";
    const plan = state.plans.find((item) => item.id === id);
    if (!plan || derivePlanStatus(plan, planApprovals(state, id)) !== "待确认") return "not-ready";
    const approvals = planApprovals(state, id);
    if (approvals.includes(state.role)) return "duplicate";

    if (state.online) {
      const roles = [...(state.serverApprovals[id] ?? [])];
      if (!roles.includes(state.role)) roles.push(state.role);
      const entry: TimelineEntry = { id: newId(), time: now(), actor: state.role, action: "确认接驳计划", detail: `${plan.stations.join(" → ")} 获 ${state.role} 确认`, phase: "接驳" };
      set({ serverApprovals: { ...state.serverApprovals, [id]: roles }, serverTimeline: [entry, ...state.serverTimeline] });
      return "ok";
    }

    set({
      pendingOps: [{
        id: newId(),
        kind: "planApproval",
        role: state.role,
        time: now(),
        planId: id,
        planLabel: plan.stations.join(" → "),
        baseline: approvals
      }, ...state.pendingOps]
    });
    return "ok";
  },

  executePlan: (id) => set((state) => {
    if (state.role === "客服主管") return {};
    const plan = state.plans.find((item) => item.id === id);
    if (!plan || derivePlanStatus(plan, planApprovals(state, id)) !== "已确认") return {};
    const plans = state.plans.map((item) => item.id === id ? { ...item, status: "已执行" as PlanStatus } : item);
    const entry: TimelineEntry = { id: newId(), time: now(), actor: state.role, action: "执行接驳计划", detail: "车辆和站点岗位已收到调度指令", phase: "接驳" };
    if (state.online) return { plans, serverTimeline: [entry, ...state.serverTimeline] };
    return { plans, pendingOps: [{ id: newId(), kind: "timeline", role: state.role, time: now(), entry }, ...state.pendingOps] };
  }),

  mergePending: () => {
    const result = reconcile(get());
    const mergedCount = (get().pendingOps.length - (result.pendingOps?.length ?? get().pendingOps.length));
    set(result);
    return { merged: mergedCount, conflicts: result.conflicts?.length ?? get().conflicts.length };
  },

  resolveConflict: (conflictId, choice) => set((state) => {
    if (state.role === "客服主管") return {};
    const conflict = state.conflicts.find((item) => item.id === conflictId);
    if (!conflict) return {};
    const winner = choice === "local" ? conflict.local.value : conflict.remote.value;
    const serverStations = state.serverStations.map((station) => {
      if (station.id !== conflict.stationId) return station;
      const next = { ...station, updatedAt: now() };
      if (conflict.field === "status") next.status = winner as StationStatus;
      else next.note = winner;
      return next;
    });
    const entry: TimelineEntry = {
      id: newId(),
      time: now(),
      actor: state.role,
      action: "协调车站字段冲突",
      detail: `${conflict.stationName}·${conflict.field === "status" ? "状态" : "现场说明"}：现场版「${conflict.local.value}」/${conflict.local.role} 与调度中心版「${conflict.remote.value}」，采用${choice === "local" ? "现场版" : "调度中心版"}「${winner}」`,
      phase: "响应"
    };
    return {
      serverStations,
      serverTimeline: [entry, ...state.serverTimeline],
      conflicts: state.conflicts.filter((item) => item.id !== conflictId),
      pendingOps: state.pendingOps.filter((op) => !(op.kind === "station" && op.stationId === conflict.stationId && op.field === conflict.field))
    };
  }),

  ingestServerStations: (remote) => set((state) => {
    let changed = false;
    const serverStations = state.serverStations.map((local) => {
      const incoming = remote.find((item) => item.id === local.id);
      // 只接受更新时间更新的快照；后到的旧值不能盖掉现场/较新记录
      if (incoming && incoming.updatedAt > local.updatedAt) { changed = true; return incoming; }
      return local;
    });
    remote.forEach((incoming) => {
      if (!state.serverStations.some((local) => local.id === incoming.id)) { serverStations.push(incoming); changed = true; }
    });
    return changed ? { serverStations } : {};
  }),

  simulateRemoteStation: (id, patch) => set((state) => ({
    serverStations: state.serverStations.map((station) => station.id === id
      ? { ...station, ...patch, updatedAt: now() }
      : station)
  }))
}), {
  name: "pair-wise-yf-47/incident-v2",
  partialize: (state) => ({
    incident: state.incident,
    serverStations: state.serverStations,
    serverTimeline: state.serverTimeline,
    serverApprovals: state.serverApprovals,
    plans: state.plans,
    role: state.role,
    online: state.online,
    pendingOps: state.pendingOps,
    conflicts: state.conflicts,
    lastSyncAt: state.lastSyncAt
  })
}));

/* ---------- 合并视图选择器：本地待同步值覆盖在服务端快照之上，绝不被服务端旧值顶掉 ---------- */

export type FieldMarker =
  | { kind: "synced"; value: string }
  | { kind: "pending"; value: string; baseline: string; role: Role; time: string }
  | { kind: "conflict"; local: { value: string; role: Role; time: string }; remote: { value: string; time: string } };

export interface StationVM extends Station {
  markers: Record<StationField, FieldMarker>;
  pending: boolean;
  hasConflict: boolean;
}

export function buildStationViews(state: IncidentState): StationVM[] {
  return state.serverStations.map((station) => {
    const markerFor = (field: StationField): FieldMarker => {
      const conflict = state.conflicts.find((item) => item.stationId === station.id && item.field === field);
      if (conflict) return { kind: "conflict", local: conflict.local, remote: conflict.remote };
      const op = state.pendingOps.find((item): item is Extract<PendingOp, { kind: "station" }> =>
        item.kind === "station" && item.stationId === station.id && item.field === field);
      if (op) return { kind: "pending", value: op.value, baseline: op.baseline, role: op.role, time: op.time };
      return { kind: "synced", value: field === "status" ? station.status : station.note };
    };
    const markers: Record<StationField, FieldMarker> = { status: markerFor("status"), note: markerFor("note") };
    const effective = (field: StationField) => {
      const marker = markers[field];
      if (marker.kind === "synced") return marker.value;
      if (marker.kind === "pending") return marker.value;
      return marker.local.value;
    };
    return {
      ...station,
      status: effective("status") as StationStatus,
      note: effective("note"),
      markers,
      pending: markers.status.kind === "pending" || markers.note.kind === "pending",
      hasConflict: markers.status.kind === "conflict" || markers.note.kind === "conflict"
    };
  });
}

export interface TimelineVM extends TimelineEntry {
  pending?: boolean;
  conflict?: boolean;
}

export function buildTimelineView(state: IncidentState): TimelineVM[] {
  const conflictKeys = new Set(state.conflicts.map((conflict) => `${conflict.stationId}:${conflict.field}`));
  const items: TimelineVM[] = state.serverTimeline.map((entry) => ({ ...entry }));
  const seen = new Set(items.map((entry) => entry.id));
  for (const op of [...state.pendingOps].reverse()) {
    const entry = timelineFromOp(op);
    if (!entry || seen.has(entry.id)) continue;
    items.push({
      ...entry,
      pending: true,
      conflict: op.kind === "station" && conflictKeys.has(`${op.stationId}:${op.field}`)
    });
    seen.add(entry.id);
  }
  return items.sort((a, b) => b.time.localeCompare(a.time));
}

export interface PlanVM extends ShuttlePlan {
  viewApprovals: Role[];
  pendingApprovals: Role[];
  viewStatus: PlanStatus;
}

export function buildPlanViews(state: IncidentState): PlanVM[] {
  return state.plans.map((plan) => {
    const viewApprovals = planApprovals(state, plan.id);
    const serverRoles = state.serverApprovals[plan.id] ?? [];
    return {
      ...plan,
      approvals: viewApprovals,
      viewApprovals,
      pendingApprovals: viewApprovals.filter((role) => !serverRoles.includes(role)),
      viewStatus: derivePlanStatus(plan, viewApprovals)
    };
  });
}
