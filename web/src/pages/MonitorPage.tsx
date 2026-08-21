import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useWorkspaceStore } from '../stores/workspaces.js';

interface Health { status: string; uptime: number; }
interface MonitorSnapshot {
  queue: { runner: { pending: number }; persisted: { queued: number; running: number; retry_wait: number }; tasks: { queued: number; running: number; failed: number; activeProcesses: number } };
  runners: { host: { running: number }; container: { active: number; image: string } };
  providers: Array<{ id: string; provider: string; model_id: string; enabled: boolean; health: { healthy: boolean; consecutiveErrors: number } }>;
}

export function MonitorPage() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const load = useWorkspaceStore((state) => state.load);
  const [health, setHealth] = useState<Health | null>(null);
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [healthData, monitorData] = await Promise.all([
        api.get<Health>('/healthz'),
        api.get<MonitorSnapshot>('/api/monitor/status'),
      ]);
      setHealth(healthData);
      setSnapshot(monitorData);
      setCheckedAt(new Date().toLocaleString());
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '监控数据加载失败');
    }
  }

  useEffect(() => {
    void load();
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const queueCount = (snapshot?.queue.runner.pending ?? 0) + (snapshot?.queue.persisted.queued ?? 0);
  return <section className="mx-auto w-full max-w-6xl space-y-5 p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">运行监控</h2><p className="mt-1 text-sm text-slate-500">查看队列、Runner、Container 和 Provider 的脱敏运行状态。</p></div><button onClick={() => void refresh()} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium hover:bg-slate-50">立即刷新</button></div>
    {error && <div role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
    <div className="grid gap-4 sm:grid-cols-4"><Metric label="服务状态" value={health?.status === 'ok' ? '正常' : '未知'} tone={health?.status === 'ok' ? 'green' : 'gray'} /><Metric label="待处理队列" value={String(queueCount)} /><Metric label="运行中 Runner" value={String((snapshot?.runners.host.running ?? 0) + (snapshot?.runners.container.active ?? 0))} /><Metric label="工作区" value={String(workspaces.length)} /></div>
    <div className="grid gap-4 lg:grid-cols-2"><Panel title="执行引擎"><StatusRow label="Host 运行中" value={snapshot?.runners.host.running ?? 0} /><StatusRow label="Container 活跃" value={snapshot?.runners.container.active ?? 0} /><p className="mt-3 truncate text-xs text-slate-400">镜像：{snapshot?.runners.container.image ?? '—'}</p></Panel><Panel title="任务运行"><StatusRow label="排队" value={snapshot?.queue.tasks.queued ?? 0} /><StatusRow label="运行中" value={snapshot?.queue.tasks.running ?? 0} /><StatusRow label="失败" value={snapshot?.queue.tasks.failed ?? 0} /><StatusRow label="脚本进程" value={snapshot?.queue.tasks.activeProcesses ?? 0} /></Panel></div>
    <Panel title="Provider 健康"><div className="space-y-2">{snapshot?.providers.map((provider) => <div key={provider.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm"><span>{provider.provider} / {provider.model_id}</span><span className={provider.health.healthy ? 'text-emerald-600' : 'text-rose-600'}>{provider.health.healthy ? '健康' : `异常（${provider.health.consecutiveErrors} 次失败）`}</span></div>)}{snapshot && !snapshot.providers.length && <p className="text-sm text-slate-400">尚未配置 Provider</p>}</div></Panel>
    <p className="text-xs text-slate-400">运行时长：{health ? formatUptime(health.uptime) : '—'}。最后检查：{checkedAt ?? '尚未检查'}</p>
  </section>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) { return <div className="rounded-2xl border border-slate-200 bg-white p-5"><h3 className="font-semibold">{title}</h3><div className="mt-4">{children}</div></div>; }
function StatusRow({ label, value }: { label: string; value: number }) { return <div className="flex items-center justify-between border-b border-slate-100 py-2 text-sm last:border-0"><span className="text-slate-500">{label}</span><span className="font-semibold text-slate-800">{value}</span></div>; }
function Metric({ label, value, tone = 'gray' }: { label: string; value: string; tone?: 'green' | 'gray' }) { return <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="text-xs text-slate-400">{label}</div><div className={`mt-2 text-2xl font-semibold ${tone === 'green' ? 'text-emerald-600' : 'text-slate-800'}`}>{value}</div></div>; }
function formatUptime(seconds: number) { const minutes = Math.floor(seconds / 60); const hours = Math.floor(minutes / 60); return hours ? `${hours}小时 ${minutes % 60}分` : `${minutes}分钟`; }
