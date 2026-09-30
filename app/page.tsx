"use client";

import { useEffect, useState } from "react";
import { App as AntApp, Alert, Badge, Button, Card, Form, Input, InputNumber, Modal, Popover, Select, Segmented, Space, Statistic, Table, Tag, Timeline, Tooltip } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnsType } from "antd/es/table";
import { fetchStations } from "../lib/query";
import { MapPanel } from "../components/MapPanel";
import {
  useIncidentStore,
  buildStationViews,
  buildTimelineView,
  buildPlanViews,
  PLAN_APPROVER_ROLES,
  STATION_CONTROL_ROLES,
  type Role,
  type PlanVM,
  type StationVM,
  type StationStatus,
  type FieldMarker,
  type PendingOp
} from "../store/incident";

const planSchema = z.object({ stations: z.array(z.string()).min(1, "至少选择两个接驳站"), vehicles: z.number().min(1).max(80), interval: z.number().min(2).max(30), operator: z.string().min(2), note: z.string().min(2) });
type PlanForm = z.infer<typeof planSchema>;

const fieldLabel = (field: "status" | "note") => field === "status" ? "车站状态" : "现场说明";

function SyncMark({ marker }: { marker: FieldMarker }) {
  if (marker.kind === "synced") return <Tag color="green">已同步</Tag>;
  if (marker.kind === "pending") {
    return <Tooltip title={`${marker.role} 离线修改 · 基线「${marker.baseline}」· ${format(new Date(marker.time), "HH:mm:ss")}`}>
      <Tag color="orange">待同步</Tag>
    </Tooltip>;
  }
  return <Popover title="字段冲突，两版均保留" content={
    <div style={{ minWidth: 220 }}>
      <p style={{ margin: "4px 0" }}><b>现场版（{marker.local.role}）：</b>{marker.local.value}<br /><small>{format(new Date(marker.local.time), "MM-dd HH:mm:ss")}</small></p>
      <p style={{ margin: "4px 0" }}><b>调度中心版：</b>{marker.remote.value}<br /><small>{format(new Date(marker.remote.time), "MM-dd HH:mm:ss")}</small></p>
      <small>请到「确认中心」协调，系统不会静默覆盖</small>
    </div>
  }><Tag color="red">待协调</Tag></Popover>;
}

function Dashboard() {
  const t = useTranslations();
  const { message } = AntApp.useApp();
  const state = useIncidentStore();
  const stations = buildStationViews(state);
  const timeline = buildTimelineView(state);
  const plans = buildPlanViews(state);
  const { data: remoteStations } = useQuery({ queryKey: ["stations"], queryFn: fetchStations, enabled: state.online, refetchInterval: 15000 });
  const [modalOpen, setModalOpen] = useState(false);
  const [panel, setPanel] = useState<string>("总览");
  const { control, handleSubmit, reset, formState: { errors } } = useForm<PlanForm>({ defaultValues: { stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", note: "优先疏运站外滞留乘客" } });

  // 只接受比本地新的服务端快照；后到的旧值不能盖掉现场记录
  useEffect(() => { if (remoteStations?.length) state.ingestServerStations(remoteStations); }, [remoteStations]); // eslint-disable-line react-hooks/exhaustive-deps

  const canControlStation = STATION_CONTROL_ROLES.includes(state.role);
  const canApprovePlan = PLAN_APPROVER_ROLES.includes(state.role);
  const readonly = state.role === "客服主管";

  const handleOnlineChange = (value: boolean) => {
    state.setOnline(value);
    if (value) {
      const next = useIncidentStore.getState();
      if (next.conflicts.length) {
        message.warning(`恢复联网：已逐项合并，${next.conflicts.length} 个字段双方都改过，已保留两版待协调`);
      } else if (!next.pendingOps.length) {
        message.success("恢复联网：待同步操作已全部合并");
      }
    }
  };

  const changeStation = (record: StationVM, status: StationStatus) => {
    const result = state.setStationStatus(record.id, status);
    if (result === "denied") message.warning("车站封闭/状态变更仅限调度员、车站值班员；客服主管仅可查看");
    else if (!state.online) message.info("已记录岗位与基线，标记为待同步，恢复联网后逐项合并");
  };

  const handleApprove = (record: PlanVM) => {
    const result = state.approvePlan(record.id);
    if (result === "denied") message.warning("接驳计划需调度员、公交接驳负责人双岗确认，该岗位无权确认");
    else if (result === "duplicate") message.warning("当前岗位已确认过该计划");
    else if (result === "not-ready") message.warning("计划当前不可确认");
    else if (!state.online) message.info("确认已带岗位标记入队，恢复联网后合并");
  };

  const handleAddTimeline = () => {
    const result = state.addTimeline({ actor: state.role, action: "更新处置", detail: "现场处置信息已同步至协同工作台", phase: "响应" });
    if (result === "denied") message.warning("客服主管仅可查看，不能补充处置记录");
  };

  const handleResolve = (conflictId: string, choice: "local" | "remote") => {
    state.resolveConflict(conflictId, choice);
    message.success(choice === "local" ? "已采用现场版并同步调度中心" : "已采用调度中心版并同步现场");
  };

  const handleManualMerge = () => {
    const result = state.mergePending();
    if (result.conflicts > 0) message.warning(`合并完成，${result.conflicts} 个字段需协调，两版均已保留`);
    else message.success("待同步操作已逐项合并");
  };

  const stationColumns: ColumnsType<StationVM> = [
    { title: "车站", dataIndex: "name" },
    { title: "区段", dataIndex: "section" },
    {
      title: "状态", dataIndex: "status",
      render: (value: StationStatus, record) => <Space size={4} wrap>
        <Tag color={value === "封闭" ? "red" : value === "限流" ? "orange" : value === "恢复中" ? "blue" : "green"}>{value}</Tag>
        <SyncMark marker={record.markers.status} />
      </Space>
    },
    { title: "滞留风险", dataIndex: "passengerRisk", render: (value) => <Badge status={value === "高" ? "error" : value === "中" ? "warning" : "success"} text={value} /> },
    {
      title: "现场说明", dataIndex: "note",
      render: (value: string, record) => <Space size={4}><span>{value}</span>{record.markers.note.kind !== "synced" && <SyncMark marker={record.markers.note} />}</Space>
    },
    { title: "更新时间", dataIndex: "updatedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    {
      title: "处置",
      render: (_, record) => <Space>
        <Tooltip title={canControlStation ? "" : "仅调度员、车站值班员可操作"}>
          <Button size="small" disabled={!canControlStation} onClick={() => changeStation(record, "限流")}>限流</Button>
        </Tooltip>
        <Tooltip title={canControlStation ? "" : "封闭车站仅限调度员、车站值班员"}>
          <Button size="small" danger={record.status !== "封闭"} disabled={!canControlStation} onClick={() => changeStation(record, record.status === "封闭" ? "恢复中" : "封闭")}>{record.status === "封闭" ? "恢复中" : "封闭"}</Button>
        </Tooltip>
      </Space>
    }
  ];

  const submitPlan = (values: PlanForm) => { const parsed = planSchema.safeParse(values); if (!parsed.success) return; state.addPlan(parsed.data); setModalOpen(false); reset(); };

  const pendingColumns: ColumnsType<PendingOp> = [
    { title: "时间", dataIndex: "time", width: 90, render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "岗位", dataIndex: "role", width: 120, render: (value: Role) => <Tag>{value}</Tag> },
    {
      title: "操作",
      render: (_, op) => op.kind === "station"
        ? `${op.stationName}·${fieldLabel(op.field)}：${op.baseline} → ${op.value}`
        : op.kind === "timeline"
          ? `补充时间线：${op.entry.action}`
          : `确认接驳计划：${op.planLabel}`
    },
    {
      title: "状态", width: 110,
      render: (_, op) => {
        const clashing = op.kind === "station" && state.conflicts.some((c) => c.stationId === op.stationId && c.field === op.field);
        return clashing ? <Tag color="red">待协调</Tag> : <Tag color="orange">待同步</Tag>;
      }
    }
  ];

  return <div className="shell">
    <aside className="side">
      <div className="brand"><b>RAIL OPS</b><span>应急协同</span></div>
      <nav>{["总览", "事件时间线", "接驳计划", "确认中心"].map((item) => <button className={panel === item ? "active" : ""} key={item} onClick={() => setPanel(item)}>{item}</button>)}</nav>
      <div className="side-status">
        <small>系统连接</small>
        <b className={state.online ? "ok" : "warn"}>{state.online ? "在线" : "弱网降级"}</b>
        <span>待同步 {state.pendingOps.length} 条 · 待协调 {state.conflicts.length} 项</span>
        <small>最近合并 {state.lastSyncAt ? format(new Date(state.lastSyncAt), "HH:mm:ss") : "暂无"}</small>
      </div>
    </aside>
    <main>
      <header><div><small>{state.incident.id} · 启动于 {format(new Date(state.incident.startedAt), "HH:mm")}</small><h1>{t("title")}</h1><p>{t("subtitle")}</p></div><Space><Segmented value={state.online} onChange={(value) => handleOnlineChange(Boolean(value))} options={[{ label: "在线", value: true }, { label: "弱网", value: false }]} /><Select<Role> value={state.role} onChange={state.setRole} options={["调度员", "车站值班员", "公交接驳负责人", "客服主管"].map((value) => ({ value: value as Role, label: `角色：${value}` }))} /></Space></header>
      <section className="metrics">
        <Card><Statistic title="事件状态" value={state.incident.status} /></Card>
        <Card><Statistic title="受影响车站" value={stations.filter((item) => item.status !== "正常").length} suffix="座" /></Card>
        <Card><Statistic title="待确认计划" value={plans.filter((item) => item.viewStatus === "待确认").length} /></Card>
        <Card><Statistic title="待同步操作" value={state.pendingOps.length} valueStyle={{ color: state.pendingOps.length ? "#d48806" : undefined }} /></Card>
        <Card><Statistic title="待协调字段" value={state.conflicts.length} valueStyle={{ color: state.conflicts.length ? "#cf1322" : undefined }} /></Card>
      </section>
      {!state.online && <div className="degrade">
        当前处于弱网降级模式。现场处置会带上<b>岗位、基线</b>并标记为<b>待同步</b>，恢复联网后逐项合并，不会被清空或静默覆盖。
        当前未同步 <b>{state.pendingOps.length}</b> 项。
        <div className="degrade-actions">
          <small>演示联网一侧（调度中心）在弱网期间也改了同一车站：</small>
          <Button size="small" onClick={() => { state.simulateRemoteStation("s1", { status: "限流" }); message.info("调度中心已将滨江站改为限流（现场尚不可见）"); }}>中心改滨江站为限流</Button>
          <Button size="small" onClick={() => { state.simulateRemoteStation("s2", { status: "封闭" }); message.info("调度中心已将会展中心站改为封闭（现场尚不可见）"); }}>中心将会展中心改为封闭</Button>
        </div>
      </div>}
      {readonly && <Alert className="role-bar" type="info" showIcon message="客服主管为只读岗位：可查看全部处置信息，不能变更车站状态、补充时间线或确认接驳计划" />}
      {panel === "总览" && <section className="overview">
        <Card title={t("stations")} className="wide" extra={<small className="role-hint">封闭/状态变更：{STATION_CONTROL_ROLES.join("、")}</small>}>
          <Table rowKey="id" dataSource={stations} columns={stationColumns} pagination={false} size="small" scroll={{ x: 820 }} />
        </Card>
        <Card title="受影响区段" className="map-card"><MapPanel stations={stations} plans={plans.filter((plan) => plan.viewStatus !== "草稿")} /></Card>
      </section>}
      {panel === "事件时间线" && <Card title="处置时间线" extra={<Space><Select value="响应" options={[{ value: "响应" }, { value: "接驳" }, { value: "恢复" }]} /><Tooltip title={readonly ? "客服主管仅可查看" : ""}><Button type="primary" disabled={readonly} onClick={handleAddTimeline}>添加处置记录</Button></Tooltip></Space>}><div className="timeline-grid"><Timeline items={timeline.map((item) => ({ color: item.phase === "恢复" ? "green" : item.phase === "接驳" ? "blue" : "red", children: <div><b>{item.action}</b><Tag>{item.actor}</Tag>{item.pending && <Tag color="orange">待同步</Tag>}{item.conflict && <Tag color="red">字段冲突待协调</Tag>}<p>{item.detail}</p><small>{format(new Date(item.time), "MM-DD HH:mm:ss")} · {item.phase}</small></div> }))} /><Card size="small" title="处置检查"><p>车站封闭与广播口径已确认。</p><p>接驳车辆到场后需调度员和公交负责人双方确认。</p><p>恢复行车前检查区间水位和站台安全。</p></Card></div></Card>}
      {panel === "接驳计划" && <Card title="公交接驳计划" extra={<Space><small className="role-hint">确认岗位：{PLAN_APPROVER_ROLES.join(" + ")}</small><Button type="primary" disabled={state.role !== "公交接驳负责人" && state.role !== "调度员"} onClick={() => setModalOpen(true)}>新建计划</Button></Space>}><Table rowKey="id" pagination={false} dataSource={plans} columns={[{ title: "接驳站", dataIndex: "stations", render: (v: string[]) => v.join(" → ") }, { title: "车辆", dataIndex: "vehicles" }, { title: "间隔", dataIndex: "interval", render: (v: number) => `${v} 分钟` }, { title: "运营方", dataIndex: "operator" }, { title: "确认", dataIndex: "approvals", render: (v: Role[], record: PlanVM) => <Space size={2} wrap>{v.length ? v.map((x) => <Tag key={x} color={record.pendingApprovals.includes(x) ? "orange" : "green"}>{x}{record.pendingApprovals.includes(x) ? "·待同步" : ""}</Tag>) : <Tag>未确认</Tag>}</Space> }, { title: "状态", dataIndex: "viewStatus", render: (v: PlanVM["viewStatus"]) => <Tag color={v === "已确认" || v === "已执行" ? "green" : v === "待确认" ? "orange" : "default"}>{v}</Tag> }, {
        title: "操作",
        render: (_, record: PlanVM) => {
          const alreadyApproved = record.viewApprovals.includes(state.role);
          return <Space>
            <Button size="small" disabled={record.status !== "草稿" || readonly} onClick={() => state.submitPlan(record.id)}>提交确认</Button>
            <Tooltip title={!canApprovePlan ? "仅调度员、公交接驳负责人可确认" : alreadyApproved ? "当前岗位已确认" : record.viewStatus !== "待确认" ? "计划当前不可确认" : ""}>
              <Button size="small" disabled={!canApprovePlan || alreadyApproved || record.viewStatus !== "待确认"} onClick={() => handleApprove(record)}>确认</Button>
            </Tooltip>
            <Button size="small" type="primary" disabled={record.viewStatus !== "已确认" || readonly} onClick={() => state.executePlan(record.id)}>执行</Button>
          </Space>;
        }
      }]} /></Card>}
      {panel === "确认中心" && <Card title="跨岗位确认中心">
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message="恢复联网后按时间逐项合并：服务端值未变则安全快进；双方都改过同一车站字段时两版都保留并列入待协调，不会静默覆盖；时间线按条目合并，计划确认按岗位取并集。" />
        <div className="confirm-head">
          <Space size="large">
            <Statistic title="待同步操作" value={state.pendingOps.length} />
            <Statistic title="待协调字段" value={state.conflicts.length} valueStyle={{ color: state.conflicts.length ? "#cf1322" : undefined }} />
          </Space>
          <Button type="primary" disabled={!state.online || !state.pendingOps.length} onClick={handleManualMerge}>立即逐项合并</Button>
        </div>
        {state.conflicts.length > 0 && <div className="conflict-list">
          <h3>待协调字段（两版均保留）</h3>
          {state.conflicts.map((conflict) => <Card key={conflict.id} size="small" className="conflict-card" title={`${conflict.stationName} · ${fieldLabel(conflict.field)}`} extra={<Tag color="red">禁止静默覆盖</Tag>}>
            <div className="conflict-versions">
              <div className="version local"><Tag color="orange">现场版</Tag><b>{conflict.local.value}</b><small>{conflict.local.role} · {format(new Date(conflict.local.time), "MM-dd HH:mm:ss")}</small></div>
              <div className="version remote"><Tag color="blue">调度中心版</Tag><b>{conflict.remote.value}</b><small>{format(new Date(conflict.remote.time), "MM-dd HH:mm:ss")}</small></div>
            </div>
            <Space style={{ marginTop: 10 }}>
              <Tooltip title={readonly ? "客服主管仅可查看，不能协调" : ""}><Button size="small" type="primary" disabled={readonly} onClick={() => handleResolve(conflict.id, "local")}>采用现场版</Button></Tooltip>
              <Tooltip title={readonly ? "客服主管仅可查看，不能协调" : ""}><Button size="small" disabled={readonly} onClick={() => handleResolve(conflict.id, "remote")}>采用中心版</Button></Tooltip>
            </Space>
          </Card>)}
        </div>}
        <h3>本地待同步队列</h3>
        <Table rowKey="id" size="small" pagination={false} dataSource={state.pendingOps} columns={pendingColumns} locale={{ emptyText: "没有待同步操作" }} />
      </Card>}
    </main>
    <Modal title="新建接驳计划" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleSubmit(submitPlan)} okText="保存草稿"><Form layout="vertical"><Form.Item label="接驳站" validateStatus={errors.stations ? "error" : ""} help={errors.stations?.message}><Controller name="stations" control={control} render={({ field }) => <Select mode="multiple" {...field} options={stations.map((item) => ({ value: item.name, label: item.name }))} />} /></Form.Item><Space><Form.Item label="车辆数"><Controller name="vehicles" control={control} render={({ field }) => <InputNumber {...field} min={1} />} /></Form.Item><Form.Item label="发车间隔"><Controller name="interval" control={control} render={({ field }) => <InputNumber {...field} min={2} addonAfter="分钟" />} /></Form.Item></Space><Form.Item label="运营方"><Controller name="operator" control={control} render={({ field }) => <Input {...field} />} /></Form.Item><Form.Item label="计划说明"><Controller name="note" control={control} render={({ field }) => <Input.TextArea {...field} />} /></Form.Item></Form></Modal>
  </div>;
}

export default function Page() { return <AntApp><Dashboard /></AntApp>; }
