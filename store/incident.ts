"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行";
export type SyncStatus = "待同步" | "已同步" | "待协调";

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
  updatedBy?: Role;
  version: number;
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

export type ActionType = "station_status" | "timeline" | "plan_submit" | "plan_approve" | "plan_execute";

export interface PendingAction {
  id: string;
  actionType: ActionType;
  action: string;
  detail: string;
  time: string;
  /** 操作岗位 */
  role: Role;
  /** 操作基线：断网前看到的服务端值 */
  baseline: {
    stationId?: string;
    stationName?: string;
    status?: StationStatus;
    note?: string;
    planId?: string;
    planStatus?: PlanStatus;
  };
  /** 操作目标值 */
  payload: {
    status?: StationStatus;
    note?: string;
    entry?: Omit<TimelineEntry, "id" | "time">;
    tempId?: string;
    planId?: string;
  };
  /** 待同步 / 已同步 / 待协调 */
  syncStatus: SyncStatus;
  syncedAt?: string;
  /** 冲突时保留两版 */
  conflict?: {
    field: string;
    localValue: string;
    serverValue: string;
    serverRole?: Role;
    serverTime?: string;
  };
}

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  stations: Station[];
  timeline: TimelineEntry[];
  plans: ShuttlePlan[];
  role: Role;
  online: boolean;
  pendingActions: PendingAction[];
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  setStationStatus: (id: string, status: StationStatus, note?: string) => void;
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time">) => void;
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals">) => void;
  submitPlan: (id: string) => void;
  approvePlan: (id: string, approver: string) => void;
  executePlan: (id: string) => void;
  queueAction: (action: string, detail: string) => void;
  syncActions: () => void;
  resolveConflict: (id: string, keep: "local" | "server") => void;
}

const now = () => new Date().toISOString();

/** 岗位权限矩阵：客服主管只能查看 */
type Permission = "stationStatus" | "addTimeline" | "addPlan" | "submitPlan" | "approvePlan" | "executePlan";
const ROLE_PERMS: Record<Role, Permission[]> = {
  调度员: ["stationStatus", "addTimeline", "addPlan", "submitPlan", "approvePlan", "executePlan"],
  车站值班员: ["stationStatus", "addTimeline", "submitPlan"],
  公交接驳负责人: ["addTimeline", "addPlan", "submitPlan", "approvePlan"],
  客服主管: []
};
export function can(role: Role, perm: Permission): boolean {
  return ROLE_PERMS[role].includes(perm);
}

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心-滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now(), updatedBy: "调度员", version: 1 },
  { id: "s2", name: "会展中心站", section: "会展-滨江", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now(), updatedBy: "调度员", version: 1 },
  { id: "s3", name: "东港站", section: "滨江-东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now(), updatedBy: "调度员", version: 1 }
];

/** 取车站的"观测值"：canonical 叠加此前未同步的本地覆盖（用于断网连续操作时的基线） */
function observedStation(state: IncidentState, id: string): Station | undefined {
  const canonical = state.stations.find((s) => s.id === id);
  if (!canonical) return undefined;
  const override = state.pendingActions
    .filter((a) => a.actionType === "station_status" && a.syncStatus === "待同步" && a.baseline.stationId === id)
    .sort((a, b) => a.time.localeCompare(b.time))
    .pop();
  if (!override) return canonical;
  return { ...canonical, status: override.payload.status ?? canonical.status, note: override.payload.note ?? canonical.note };
}

/** 逐项合并：把待同步操作按基线与 canonical 比对，相同则提交，冲突则保留两版待协调 */
function applySync(state: IncidentState): Pick<IncidentState, "stations" | "timeline" | "plans" | "pendingActions"> {
  if (!state.online) return { stations: state.stations, timeline: state.timeline, plans: state.plans, pendingActions: state.pendingActions };

  let stations = state.stations.map((s) => ({ ...s }));
  let timeline = state.timeline.map((e) => ({ ...e }));
  let plans = state.plans.map((p) => ({ ...p, approvals: [...p.approvals] }));
  const actions = state.pendingActions.map((a) => ({
    ...a,
    baseline: { ...a.baseline },
    payload: { ...a.payload },
    conflict: a.conflict ? { ...a.conflict } : undefined
  }));

  for (const action of actions) {
    if (action.syncStatus !== "待同步") continue;

    if (action.actionType === "station_status") {
      const idx = stations.findIndex((s) => s.id === action.baseline.stationId);
      if (idx === -1) {
        action.syncStatus = "已同步";
        action.syncedAt = now();
        continue;
      }
      const current = stations[idx];
      const statusChanged = action.payload.status !== undefined && current.status !== action.baseline.status;
      const noteChanged = action.payload.note !== undefined && current.note !== action.baseline.note;
      if (!statusChanged && !noteChanged) {
        // 基线未被他人改动 → 提交本地值
        stations[idx] = {
          ...current,
          status: action.payload.status ?? current.status,
          note: action.payload.note ?? current.note,
          updatedAt: action.time,
          updatedBy: action.role,
          version: current.version + 1
        };
        action.syncStatus = "已同步";
        action.syncedAt = now();
      } else {
        // 两边都改了同一字段 → 保留两版，列入待协调，不静默覆盖
        action.syncStatus = "待协调";
        action.conflict = {
          field: statusChanged ? "status" : "note",
          localValue: String(action.payload.status ?? action.payload.note),
          serverValue: String(statusChanged ? current.status : current.note),
          serverRole: current.updatedBy,
          serverTime: current.updatedAt
        };
      }
    } else if (action.actionType === "timeline") {
      if (!timeline.some((e) => e.id === action.payload.tempId)) {
        timeline = [{ ...action.payload.entry!, id: action.payload.tempId!, time: action.time }, ...timeline];
      }
      action.syncStatus = "已同步";
      action.syncedAt = now();
    } else if (action.actionType === "plan_submit") {
      const idx = plans.findIndex((p) => p.id === action.payload.planId);
      if (idx !== -1 && plans[idx].status === "草稿") {
        plans[idx] = { ...plans[idx], status: "待确认" };
      }
      action.syncStatus = "已同步";
      action.syncedAt = now();
    } else if (action.actionType === "plan_approve") {
      const idx = plans.findIndex((p) => p.id === action.payload.planId);
      if (idx === -1) {
        action.syncStatus = "已同步";
        action.syncedAt = now();
        continue;
      }
      const plan = plans[idx];
      if (!plan.approvals.includes(action.role)) {
        const approvals = Array.from(new Set([...plan.approvals, action.role]));
        // 接驳计划确认需调度员与公交接驳负责人双方确认
        const status: PlanStatus = approvals.includes("调度员") && approvals.includes("公交接驳负责人") ? "已确认" : plan.status;
        plans[idx] = { ...plan, approvals, status };
      }
      action.syncStatus = "已同步";
      action.syncedAt = now();
    } else if (action.actionType === "plan_execute") {
      const idx = plans.findIndex((p) => p.id === action.payload.planId);
      if (idx === -1) {
        action.syncStatus = "已同步";
        action.syncedAt = now();
        continue;
      }
      if (plans[idx].status === "已确认") {
        plans[idx] = { ...plans[idx], status: "已执行" };
        action.syncStatus = "已同步";
        action.syncedAt = now();
      } else if (plans[idx].status === "已执行") {
        action.syncStatus = "已同步";
        action.syncedAt = now();
      } else {
        action.syncStatus = "待协调";
        action.conflict = {
          field: "planStatus",
          localValue: "执行",
          serverValue: plans[idx].status,
          serverTime: now()
        };
      }
    }
  }

  return { stations, timeline, plans, pendingActions: actions };
}

/** 展示用视图：断网时叠加未同步的本地覆盖；在线时显示 canonical 服务端值并标记待同步/待协调 */
export interface StationView extends Station {
  pendingSync: boolean;
  hasConflict: boolean;
}
export interface TimelineView extends TimelineEntry {
  pendingSync: boolean;
}
export interface PlanView extends ShuttlePlan {
  pendingSync: boolean;
  hasConflict: boolean;
}

export function stationViews(state: IncidentState): StationView[] {
  return state.stations.map((s) => {
    const override = state.pendingActions
      .filter((a) => a.actionType === "station_status" && a.syncStatus === "待同步" && a.baseline.stationId === s.id)
      .sort((a, b) => a.time.localeCompare(b.time))
      .pop();
    const hasConflict = state.pendingActions.some(
      (a) => a.actionType === "station_status" && a.syncStatus === "待协调" && a.baseline.stationId === s.id
    );
    const pendingSync = !!override;
    if (override && !state.online) {
      return { ...s, status: override.payload.status ?? s.status, note: override.payload.note ?? s.note, pendingSync, hasConflict };
    }
    return { ...s, pendingSync, hasConflict };
  });
}

export function timelineViews(state: IncidentState): TimelineView[] {
  const canonical: TimelineView[] = state.timeline.map((e) => ({ ...e, pendingSync: false }));
  if (state.online) return canonical;
  const pending: TimelineView[] = state.pendingActions
    .filter((a) => a.actionType === "timeline" && a.syncStatus === "待同步")
    .map((a) => ({ ...(a.payload.entry as TimelineEntry), id: a.payload.tempId!, time: a.time, pendingSync: true }));
  return [...pending, ...canonical].sort((a, b) => b.time.localeCompare(a.time));
}

export function planViews(state: IncidentState): PlanView[] {
  return state.plans.map((p) => {
    const hasConflict = state.pendingActions.some(
      (a) => a.syncStatus === "待协调" && (a.actionType === "plan_submit" || a.actionType === "plan_approve" || a.actionType === "plan_execute") && a.payload.planId === p.id
    );
    const related = state.pendingActions
      .filter((a) => a.syncStatus === "待同步" && (a.actionType === "plan_submit" || a.actionType === "plan_approve" || a.actionType === "plan_execute") && a.payload.planId === p.id)
      .sort((a, b) => a.time.localeCompare(b.time));
    const pendingSync = related.length > 0;
    if (state.online || !related.length) {
      return { ...p, approvals: [...p.approvals], pendingSync, hasConflict };
    }
    let view: PlanView = { ...p, approvals: [...p.approvals], pendingSync, hasConflict };
    for (const a of related) {
      if (a.actionType === "plan_submit" && view.status === "草稿") view = { ...view, status: "待确认" };
      if (a.actionType === "plan_approve" && !view.approvals.includes(a.role)) {
        const approvals = Array.from(new Set([...view.approvals, a.role]));
        const status: PlanStatus = approvals.includes("调度员") && approvals.includes("公交接驳负责人") ? "已确认" : view.status;
        view = { ...view, approvals, status };
      }
      if (a.actionType === "plan_execute" && view.status === "已确认") view = { ...view, status: "已执行" };
    }
    return view;
  });
}

export const useIncidentStore = create<IncidentState>()(
  persist(
    (set) => ({
      incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
      stations: seedStations,
      timeline: [
        { id: "e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
        { id: "e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
      ],
      plans: [
        { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: ["调度员"], note: "优先疏运站外滞留乘客" }
      ],
      role: "调度员",
      online: true,
      pendingActions: [],
      setRole: (role) => set({ role }),
      setOnline: (online) => set({ online }),
      setStationStatus: (id, status, note) =>
        set((state) => {
          if (!can(state.role, "stationStatus")) return state;
          const observed = observedStation(state, id);
          if (!observed) return state;
          if (state.online) {
            return {
              stations: state.stations.map((s) =>
                s.id === id ? { ...s, status, note: note ?? s.note, updatedAt: now(), updatedBy: state.role, version: s.version + 1 } : s
              ),
              timeline: [
                {
                  id: crypto.randomUUID(),
                  time: now(),
                  actor: state.role,
                  action: "更新车站状态",
                  detail: `${observed.name} → ${status}`,
                  phase: status === "正常" || status === "恢复中" ? "恢复" : "响应"
                },
                ...state.timeline
              ]
            };
          }
          // 弱网：操作带岗位、基线入队，不覆盖 canonical
          const action: PendingAction = {
            id: crypto.randomUUID(),
            actionType: "station_status",
            action: "更新车站状态",
            detail: `${observed.name} → ${status}`,
            time: now(),
            role: state.role,
            baseline: { stationId: id, stationName: observed.name, status: observed.status, note: observed.note },
            payload: { status, note: note ?? observed.note },
            syncStatus: "待同步"
          };
          return { pendingActions: [action, ...state.pendingActions] };
        }),
      addTimeline: (entry) =>
        set((state) => {
          if (!can(state.role, "addTimeline")) return state;
          if (state.online) {
            return { timeline: [{ ...entry, id: crypto.randomUUID(), time: now() }, ...state.timeline] };
          }
          const action: PendingAction = {
            id: crypto.randomUUID(),
            actionType: "timeline",
            action: entry.action,
            detail: entry.detail,
            time: now(),
            role: state.role,
            baseline: {},
            payload: { entry, tempId: crypto.randomUUID() },
            syncStatus: "待同步"
          };
          return { pendingActions: [action, ...state.pendingActions] };
        }),
      addPlan: (plan) =>
        set((state) => {
          if (!can(state.role, "addPlan")) return state;
          return { plans: [{ ...plan, id: crypto.randomUUID(), status: "草稿", approvals: [] }, ...state.plans] };
        }),
      submitPlan: (id) =>
        set((state) => {
          if (!can(state.role, "submitPlan")) return state;
          const plan = state.plans.find((p) => p.id === id);
          if (!plan) return state;
          if (state.online) {
            return {
              plans: state.plans.map((p) => (p.id === id ? { ...p, status: "待确认" } : p)),
              timeline: [
                { id: crypto.randomUUID(), time: now(), actor: state.role, action: "提交接驳计划", detail: `计划 ${id.slice(0, 6)} 等待跨岗位确认`, phase: "接驳" },
                ...state.timeline
              ]
            };
          }
          const action: PendingAction = {
            id: crypto.randomUUID(),
            actionType: "plan_submit",
            action: "提交接驳计划",
            detail: `计划 ${id.slice(0, 6)} 等待跨岗位确认`,
            time: now(),
            role: state.role,
            baseline: { planId: id, planStatus: plan.status },
            payload: { planId: id },
            syncStatus: "待同步"
          };
          return { pendingActions: [action, ...state.pendingActions] };
        }),
      approvePlan: (id, approver) =>
        set((state) => {
          if (!can(state.role, "approvePlan")) return state;
          const plan = state.plans.find((p) => p.id === id);
          if (!plan) return state;
          if (state.online) {
            if (plan.approvals.includes(approver)) return state;
            const approvals = Array.from(new Set([...plan.approvals, approver]));
            // 接驳计划确认需调度员与公交接驳负责人双方确认
            const status: PlanStatus = approvals.includes("调度员") && approvals.includes("公交接驳负责人") ? "已确认" : plan.status;
            return { plans: state.plans.map((p) => (p.id === id ? { ...p, approvals, status } : p)) };
          }
          const action: PendingAction = {
            id: crypto.randomUUID(),
            actionType: "plan_approve",
            action: "确认接驳计划",
            detail: `${approver} 确认计划 ${id.slice(0, 6)}`,
            time: now(),
            role: state.role,
            baseline: { planId: id, planStatus: plan.status },
            payload: { planId: id },
            syncStatus: "待同步"
          };
          return { pendingActions: [action, ...state.pendingActions] };
        }),
      executePlan: (id) =>
        set((state) => {
          if (!can(state.role, "executePlan")) return state;
          const plan = state.plans.find((p) => p.id === id);
          if (!plan) return state;
          if (state.online) {
            return {
              plans: state.plans.map((p) => (p.id === id ? { ...p, status: "已执行" } : p)),
              timeline: [
                { id: crypto.randomUUID(), time: now(), actor: state.role, action: "执行接驳计划", detail: "车辆和站点岗位已收到调度指令", phase: "接驳" },
                ...state.timeline
              ]
            };
          }
          const action: PendingAction = {
            id: crypto.randomUUID(),
            actionType: "plan_execute",
            action: "执行接驳计划",
            detail: `计划 ${id.slice(0, 6)} 已下发执行`,
            time: now(),
            role: state.role,
            baseline: { planId: id, planStatus: plan.status },
            payload: { planId: id },
            syncStatus: "待同步"
          };
          return { pendingActions: [action, ...state.pendingActions] };
        }),
      queueAction: (action, detail) =>
        set((state) => ({
          pendingActions: [
            {
              id: crypto.randomUUID(),
              actionType: "station_status",
              action,
              detail,
              time: now(),
              role: state.role,
              baseline: {},
              payload: {},
              syncStatus: "待同步"
            },
            ...state.pendingActions
          ]
        })),
      syncActions: () => set((state) => (state.online ? applySync(state) : state)),
      resolveConflict: (id, keep) =>
        set((state) => {
          const action = state.pendingActions.find((a) => a.id === id);
          if (!action || action.syncStatus !== "待协调") return state;
          let stations = state.stations;
          if (keep === "local" && action.actionType === "station_status") {
            stations = state.stations.map((s) =>
              s.id === action.baseline.stationId
                ? { ...s, status: action.payload.status ?? s.status, note: action.payload.note ?? s.note, updatedAt: now(), updatedBy: action.role, version: s.version + 1 }
                : s
            );
          }
          return {
            stations,
            pendingActions: state.pendingActions.map((a) => (a.id === id ? { ...a, syncStatus: "已同步" as SyncStatus, syncedAt: now(), conflict: undefined } : a))
          };
        })
    }),
    { name: "pair-wise-yf-47/incident" }
  )
);
