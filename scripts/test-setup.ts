// 测试专用：内存 localStorage，必须在 import store 前执行
const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k)
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
// zustand persist 的默认存储需要 window 存在才启用
Object.defineProperty(globalThis, "window", { value: { localStorage: storage }, configurable: true });
