"use client";

import { useEffect, useState } from "react";
import { App as AntApp, Badge, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Segmented, Space, Statistic, Table, Tag, Timeline, Alert, List, Tooltip } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnsType } from "antd/es/table";
import { MapPanel } from "../components/MapPanel";
import {
  useIncidentStore,
  can,
  stationViews,
  timelineViews,
  planViews,
  type Role,
  type ShuttlePlan,
  type Station,
  type StationStatus,
  type StationView,
  type PendingAction
} from "../store/incident";

const planSchema = z.object({ stations: z.array(z.string()).min(1, "至少选择两个接驳站"), vehicles: z.number().min(1).max(80), interval: z.number().min(2).max(30), operator: z.string().min(2), note: z.string().min(2) });
type PlanForm = z.infer<typeof planSchema>;

const syncColor: Record<string, string> = { 待同步: "orange", 已同步: "green", 待协调: "red" };

function Dashboard() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const state = useIncidentStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [panel, setPanel] = useState<string>("总览");
  const { control, handleSubmit, reset, formState: { errors } } = useForm<PlanForm>({ defaultValues: { stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", note: "优先疏运站外滞留乘客" } });

  useEffect(() => { if (!state.online) queryClient.cancelQueries({ queryKey: ["stations"] }); }, [state.online, queryClient]);

  const stations = stationViews(state);
  const timeline = timelineViews(state);
  const plans = planViews(state);
  const pendingCount = state.pendingActions.filter((a) => a.syncStatus === "待同步").length;
  const conflictCount = state.pendingActions.filter((a) => a.syncStatus === "待协调").length;
  const readonly = state.role === "客服主管";

  const stationColumns: ColumnsType<Station> = [
    { title: "车站", dataIndex: "name", render: (value, record) => { const view = record as StationView; return <Space>{value}{view.hasConflict && <Tag color="red">待协调</Tag>}</Space>; } },
    { title: "区段", dataIndex: "section" },
    { title: "状态", dataIndex: "status", render: (value: StationStatus) => <Tag color={value === "封闭" ? "red" : value === "限流" ? "orange" : value === "恢复中" ? "blue" : "green"}>{value}</Tag> },
    { title: "滞留风险", dataIndex: "passengerRisk", render: (value) => <Badge status={value === "高" ? "error" : value === "中" ? "warning" : "success"} text={value} /> },
    { title: "现场说明", dataIndex: "note" },
    { title: "更新时间", dataIndex: "updatedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "同步", dataIndex: "pendingSync", render: (_: unknown, record: Station) => { const view = record as StationView; return view.pendingSync ? <Tag color="orange">待同步</Tag> : <Tag>已同步</Tag>; } },
    {
      title: "处置",
      render: (_, record) => (
        <Space>
          <Tooltip title={readonly ? "客服主管仅可查看" : ""}><Button size="small" disabled={readonly || !can(state.role, "stationStatus")} onClick={() => state.setStationStatus(record.id, "限流")}>限流</Button></Tooltip>
          <Tooltip title={readonly ? "客服主管仅可查看" : ""}><Button size="small" disabled={readonly || !can(state.role, "stationStatus")} danger={record.status !== "封闭"} onClick={() => state.setStationStatus(record.id, record.status === "封闭" ? "恢复中" : "封闭")}>{record.status === "封闭" ? "恢复中" : "封闭"}</Button></Tooltip>
        </Space>
      )
    }
  ];

  const submitPlan = (values: PlanForm) => { const parsed = planSchema.safeParse(values); if (!parsed.success) return; state.addPlan(parsed.data); setModalOpen(false); reset(); };

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><b>RAIL OPS</b><span>应急协同</span></div>
        <nav>
          {["总览", "事件时间线", "接驳计划", "确认中心"].map((item) => (
            <button className={panel === item ? "active" : ""} key={item} onClick={() => setPanel(item)}>
              {item}
              {item === "确认中心" && pendingCount > 0 && <Badge count={pendingCount} size="small" style={{ marginLeft: 8 }} />}
            </button>
          ))}
        </nav>
        <div className="side-status">
          <small>系统连接</small>
          <b className={state.online ? "ok" : "warn"}>{state.online ? "在线" : "弱网降级"}</b>
          <span>最近缓存 32 秒前</span>
          <span className="sync-count">待同步 <b className={pendingCount ? "warn" : "ok"}>{pendingCount}</b> 项 · 待协调 <b className={conflictCount ? "warn" : "ok"}>{conflictCount}</b> 项</span>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <small>{state.incident.id} · 启动于 {format(new Date(state.incident.startedAt), "HH:mm")}</small>
            <h1>{t("title")}</h1>
            <p>{t("subtitle")}</p>
          </div>
          <Space>
            <Segmented value={state.online} onChange={(value) => state.setOnline(Boolean(value))} options={[{ label: "在线", value: true }, { label: "弱网", value: false }]} />
            <Select<Role> value={state.role} onChange={state.setRole} options={["调度员", "车站值班员", "公交接驳负责人", "客服主管"].map((value) => ({ value: value as Role, label: `角色：${value}` }))} />
          </Space>
        </header>

        <section className="metrics">
          <Card><Statistic title="事件状态" value={state.incident.status} /></Card>
          <Card><Statistic title="受影响车站" value={stations.filter((item) => item.status !== "正常").length} suffix="座" /></Card>
          <Card><Statistic title="待确认计划" value={plans.filter((item) => item.status === "待确认").length} /></Card>
          <Card><Statistic title="待同步操作" value={pendingCount} suffix="项" valueStyle={{ color: pendingCount ? "#d48806" : "#3f8600" }} /></Card>
        </section>

        {!state.online && (
          <Alert className="degrade" type="warning" showIcon message="弱网降级模式" description="当前显示最近缓存数据。关键处置会进入本地队列并记录岗位与基线，恢复联网后逐项合并；若两边都改过同一字段，将保留两版并列入待协调，不会静默覆盖。" />
        )}
        {state.online && pendingCount > 0 && (
          <Alert
            className="degrade"
            type="info"
            showIcon
            message={`恢复联网：${pendingCount} 项离线操作待同步`}
            description="将按基线逐项合并到现场记录。"
            action={<Button size="small" type="primary" onClick={state.syncActions}>逐项同步</Button>}
          />
        )}
        {conflictCount > 0 && (
          <Alert
            className="degrade"
            type="error"
            showIcon
            message={`${conflictCount} 项操作待协调`}
            description="离线值与现场值在恢复联网时发生冲突，已保留两版，请在确认中心裁定。"
            action={<Button size="small" danger onClick={() => setPanel("确认中心")}>前往协调</Button>}
          />
        )}

        {panel === "总览" && (
          <section className="overview">
            <Card title={t("stations")} className="wide" extra={<Tag>{readonly ? "仅查看" : "可处置"}</Tag>}>
              <Table rowKey="id" dataSource={stations} columns={stationColumns} pagination={false} size="small" scroll={{ x: 820 }} />
            </Card>
            <Card title="受影响区段" className="map-card"><MapPanel stations={stations} plans={plans.filter((plan) => plan.status !== "草稿")} /></Card>
          </section>
        )}

        {panel === "事件时间线" && (
          <Card
            title="处置时间线"
            extra={
              <Space>
                <Select value="响应" options={[{ value: "响应" }, { value: "接驳" }, { value: "恢复" }]} />
                <Tooltip title={readonly ? "客服主管仅可查看" : ""}><Button type="primary" disabled={readonly || !can(state.role, "addTimeline")} onClick={() => state.addTimeline({ actor: state.role, action: "更新处置", detail: "现场处置信息已同步至协同工作台", phase: "响应" })}>添加处置记录</Button></Tooltip>
              </Space>
            }
          >
            <div className="timeline-grid">
              <Timeline
                items={timeline.map((item) => ({
                  color: item.phase === "恢复" ? "green" : item.phase === "接驳" ? "blue" : "red",
                  children: (
                    <div>
                      <b>{item.action}</b>
                      <Tag>{item.actor}</Tag>
                      {item.pendingSync && <Tag color="orange">待同步</Tag>}
                      <p>{item.detail}</p>
                      <small>{format(new Date(item.time), "MM-DD HH:mm:ss")} · {item.phase}</small>
                    </div>
                  )
                }))}
              />
              <Card size="small" title="处置检查">
                <p>车站封闭与广播口径已确认。</p>
                <p>接驳车辆到场后需调度员和公交负责人双方确认。</p>
                <p>恢复行车前检查区间水位和站台安全。</p>
              </Card>
            </div>
          </Card>
        )}

        {panel === "接驳计划" && (
          <Card
            title="公交接驳计划"
            extra={<Tooltip title={readonly ? "客服主管仅可查看" : ""}><Button type="primary" disabled={readonly || !can(state.role, "addPlan")} onClick={() => setModalOpen(true)}>新建计划</Button></Tooltip>}
          >
            <Table
              rowKey="id"
              pagination={false}
              dataSource={plans}
              columns={[
                { title: "接驳站", dataIndex: "stations", render: (v: string[]) => v.join(" → ") },
                { title: "车辆", dataIndex: "vehicles" },
                { title: "间隔", dataIndex: "interval", render: (v: number) => `${v} 分钟` },
                { title: "运营方", dataIndex: "operator" },
                {
                  title: "确认",
                  dataIndex: "approvals",
                  render: (v: string[]) => v.length ? v.map((x) => <Tag key={x} color="green">{x}</Tag>) : <Tag>未确认</Tag>
                },
                {
                  title: "状态",
                  dataIndex: "status",
                  render: (v, record) => (
                    <Space>
                      <Tag color={v === "已确认" || v === "已执行" ? "green" : v === "待确认" ? "orange" : "default"}>{v}</Tag>
                      {record.pendingSync && <Tag color="orange">待同步</Tag>}
                      {record.hasConflict && <Tag color="red">待协调</Tag>}
                    </Space>
                  )
                },
                {
                  title: "操作",
                  render: (_, record: ShuttlePlan & { pendingSync: boolean; hasConflict: boolean }) => (
                    <Space>
                      <Button size="small" disabled={record.status !== "草稿" || !can(state.role, "submitPlan")} onClick={() => state.submitPlan(record.id)}>提交确认</Button>
                      <Tooltip title={readonly ? "客服主管仅可查看" : ""}>
                        <Button size="small" disabled={record.status !== "待确认" || readonly || !can(state.role, "approvePlan") || record.approvals.includes(state.role)} onClick={() => state.approvePlan(record.id, state.role)}>确认</Button>
                      </Tooltip>
                      <Button size="small" type="primary" disabled={record.status !== "已确认" || !can(state.role, "executePlan")} onClick={() => state.executePlan(record.id)}>执行</Button>
                    </Space>
                  )
                }
              ]}
            />
          </Card>
        )}

        {panel === "确认中心" && (
          <Card
            title="跨岗位确认中心"
            extra={<Button type="primary" disabled={!state.online || !pendingCount} onClick={state.syncActions}>逐项同步本地队列</Button>}
          >
            <Alert type="info" showIcon style={{ marginBottom: 14 }} message="接驳计划确认需调度员与公交接驳负责人双方确认；车站封闭/限流需调度员或车站值班员；客服主管仅可查看。" />
            <Timeline
              items={plans.map((plan) => ({
                children: (
                  <div className="approval">
                    <b>{plan.stations.join(" → ")}</b>
                    <Tag>{plan.status}</Tag>
                    {plan.pendingSync && <Tag color="orange">待同步</Tag>}
                    {plan.hasConflict && <Tag color="red">待协调</Tag>}
                    <p>{plan.vehicles} 辆，间隔 {plan.interval} 分钟，{plan.note}</p>
                    <small>已确认：{plan.approvals.join("、") || "暂无"}</small>
                  </div>
                )
              }))}
            />

            <Card size="small" title={`本地同步队列（${state.pendingActions.length}）`} style={{ marginTop: 16 }}>
              {state.pendingActions.length === 0 && <p>暂无离线操作。</p>}
              <List
                size="small"
                dataSource={state.pendingActions}
                renderItem={(action: PendingAction) => (
                  <List.Item
                    actions={
                      action.syncStatus === "待协调"
                        ? [
                            <Button key="local" size="small" onClick={() => state.resolveConflict(action.id, "local")}>采用离线值</Button>,
                            <Button key="server" size="small" onClick={() => state.resolveConflict(action.id, "server")}>采用现场值</Button>
                          ]
                        : undefined
                    }
                  >
                    <List.Item.Meta
                      title={
                        <Space>
                          <Tag color={syncColor[action.syncStatus]}>{action.syncStatus}</Tag>
                          <Tag>{action.role}</Tag>
                          <span>{action.action}</span>
                        </Space>
                      }
                      description={
                        <div>
                          <div>{action.detail}</div>
                          <small>
                            {format(new Date(action.time), "MM-DD HH:mm:ss")}
                            {action.baseline.stationName ? ` · 基线 ${action.baseline.stationName} ${action.baseline.status ?? ""}` : ""}
                            {action.baseline.planStatus ? ` · 基线 计划${action.baseline.planStatus}` : ""}
                            {action.syncedAt ? ` · 已于 ${format(new Date(action.syncedAt), "HH:mm:ss")} 同步` : ""}
                          </small>
                          {action.syncStatus === "待协调" && action.conflict && (
                            <Alert
                              style={{ marginTop: 8 }}
                              type="error"
                              showIcon
                              message={
                                <span>
                                  两版均保留：离线值 <b>{action.conflict.localValue}</b>（{action.role}） vs 现场值 <b>{action.conflict.serverValue}</b>
                                  {action.conflict.serverRole ? `（${action.conflict.serverRole} 于 ${format(new Date(action.conflict.serverTime!), "HH:mm:ss")} 修改）` : ""}
                                </span>
                              }
                            />
                          )}
                        </div>
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          </Card>
        )}
      </main>

      <Modal title="新建接驳计划" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleSubmit(submitPlan)} okText="保存草稿">
        <Form layout="vertical">
          <Form.Item label="接驳站" validateStatus={errors.stations ? "error" : ""} help={errors.stations?.message}>
            <Controller name="stations" control={control} render={({ field }) => <Select mode="multiple" {...field} options={state.stations.map((item) => ({ value: item.name, label: item.name }))} />} />
          </Form.Item>
          <Space>
            <Form.Item label="车辆数"><Controller name="vehicles" control={control} render={({ field }) => <InputNumber {...field} min={1} />} /></Form.Item>
            <Form.Item label="发车间隔"><Controller name="interval" control={control} render={({ field }) => <InputNumber {...field} min={2} addonAfter="分钟" />} /></Form.Item>
          </Space>
          <Form.Item label="运营方"><Controller name="operator" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Form.Item label="计划说明"><Controller name="note" control={control} render={({ field }) => <Input.TextArea {...field} />} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default function Page() { return <AntApp><Dashboard /></AntApp>; }
