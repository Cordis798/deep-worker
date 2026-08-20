import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useWorkspaceStore } from '../stores/workspaces.js';

interface Health { status: string; uptime: number; }
export function MonitorPage() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const load = useWorkspaceStore((state) => state.load);
  const [health, setHealth] = useState<Health | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function refresh() { try { const data = await api.get<Health>('/healthz'); setHealth(data); setCheckedAt(new Date().toLocaleString()); setError(null); } catch (reason) { setError(reason instanceof Error ? reason.message : '健康检查失败'); } }
  useEffect(() => { void load(); void refresh(); const timer = window.setInterval(() => void refresh(), 15_000); return () => window.clearInterval(timer); }, [load]);
  return <section className="mx-auto w-full max-w-6xl space-y-5 p-4 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">运行监控</h2><p className="mt-1 text-sm text-slate-500">查看服务、工作区和当前客户端连接状态。</p></div><button onClick={() => void refresh()} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium hover:bg-slate-50">立即检查</button></div>{error && <div role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}<div className="grid gap-4 sm:grid-cols-3"><Metric label="服务状态" value={health?.status === 'ok' ? '正常' : '未知'} tone={health?.status === 'ok' ? 'green' : 'gray'} /><Metric label="运行时长" value={health ? formatUptime(health.uptime) : '—'} /><Metric label="工作区" value={String(workspaces.length)} /></div><div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between"><h3 className="font-semibold">Pi Runner 能力</h3><span className="rounded-full bg-indigo-50 px-3 py-1 text-xs text-indigo-700">Fake/Real 可切换</span></div><div className="mt-4 grid gap-3 sm:grid-cols-3"><Capability title="会话隔离" detail="每个 Runtime Session 独立上下文" /><Capability title="流式事件" detail="WebSocket 转发文本与工具轨迹" /><Capability title="可靠性" detail="队列、重试与重启恢复" /></div></div><p className="text-xs text-slate-400">最后检查：{checkedAt ?? '尚未检查'}。容器、Provider 和渠道监控将在对应阶段接入。</p></section>;
}
function Metric({ label, value, tone = 'gray' }: { label: string; value: string; tone?: 'green' | 'gray' }) { return <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="text-xs text-slate-400">{label}</div><div className={`mt-2 text-2xl font-semibold ${tone === 'green' ? 'text-emerald-600' : 'text-slate-800'}`}>{value}</div></div>; }
function Capability({ title, detail }: { title: string; detail: string }) { return <div className="rounded-xl bg-slate-50 p-4"><div className="font-medium">{title}</div><div className="mt-1 text-xs leading-5 text-slate-500">{detail}</div></div>; }
function formatUptime(seconds: number) { const minutes = Math.floor(seconds / 60); const hours = Math.floor(minutes / 60); return hours ? `${hours}小时 ${minutes % 60}分` : `${minutes}分钟`; }
