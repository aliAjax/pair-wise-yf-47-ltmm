import type { Station } from "../store/incident";

/**
 * 模拟从调度中心拉取车站快照。只做读取展示；是否接受该快照由
 * ingestServerStations 按 updatedAt 判定，后到的旧值不能覆盖现场记录。
 */
export async function fetchStations(): Promise<Station[]> {
  await new Promise((resolve) => setTimeout(resolve, 120));
  const raw = localStorage.getItem("pair-wise-yf-47/incident-v2");
  if (!raw) return [];
  return (JSON.parse(raw).state?.serverStations ?? []) as Station[];
}
