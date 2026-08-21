import { useEffect, useState } from 'react';
import { api, getErrorMessage } from '../api/client.js';

interface UsageStats {
  summary: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; reasoningTokens: number; providerEstimatedCostUSD: number; billedCostUSD: number; runCount: number; activeDays: number };
  daily: Array<{ date: string; model: string; input_tokens: number; output_tokens: number; provider_estimated_cost_usd: number; run_count: number }>;
}
interface UsageRecord { eventId: string; createdAt: string; workspaceJid: string; agentId: string | null; model: string; inputTokens: number; outputTokens: number; providerEstimatedCostUSD: number; billedCostUSD: number | null; }

function number(value: number): string { return new Intl.NumberFormat('zh-CN').format(value); }
function money(value: number): string { return `$${value.toFixed(4)}`; }

export function UsagePage() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [days, setDays] = useState('7');
  const [model, setModel] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [agent, setAgent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const query = new URLSearchParams({ days });
      if (model) query.set('model', model);
      if (workspace) query.set('workspaceJid', workspace);
      if (agent) query.set('agentId', agent);
      const [summary, detail] = await Promise.all([
        api.get<UsageStats>(`/api/usage/stats?${query.toString()}`),
        api.get<{ records: UsageRecord[] }>(`/api/usage/records?${query.toString()}&pageSize=50`),
      ]);
      setStats(summary);
      setRecords(detail.records);
      setError(null);
    } catch (reason) { setError(getErrorMessage(reason, '用量加载失败')); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [days, model, workspace, agent]);
  function exportCsv() { const query = new URLSearchParams({ days }); if (model) query.set('model', model); if (workspace) query.set('workspaceJid', workspace); if (agent) query.set('agentId', agent); window.location.assign(`/api/usage/export.csv?${query.toString()}`); }
  const summary = stats?.summary;
  return <section className="mx-auto w-full max-w-6xl space-y-5 p-4 sm:p-6">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-semibold">用量</h2><p className="mt-1 text-sm text-slate-500">按 Agent、Workspace 和模型查看 Token、成本与运行次数。</p></div><div className="flex gap-2"><button onClick={exportCsv} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50">导出 CSV</button><button onClick={() => void load()} className="rounded-xl bg-slate-950 px-3 py-2 text-sm text-white hover:bg-slate-800">刷新</button></div></div>
    {error && <div role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
    <div className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-4"><label className="text-xs text-slate-500">时间范围<select value={days} onChange={(event) => setDays(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm"><option value="7">近 7 天</option><option value="14">近 14 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option></select></label><label className="text-xs text-slate-500">模型<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="全部模型" className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm" /></label><label className="text-xs text-slate-500">Workspace<input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="Workspace JID" className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm" /></label><label className="text-xs text-slate-500">Agent<input value={agent} onChange={(event) => setAgent(event.target.value)} placeholder="Agent ID" className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-2 text-sm" /></label></div>
    {loading && !stats ? <div className="rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-400">加载用量中...</div> : <><div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6"><Metric label="运行次数" value={number(summary?.runCount ?? 0)} /><Metric label="输入 Token" value={number(summary?.inputTokens ?? 0)} /><Metric label="输出 Token" value={number(summary?.outputTokens ?? 0)} /><Metric label="缓存 Token" value={number((summary?.cacheReadInputTokens ?? 0) + (summary?.cacheCreationInputTokens ?? 0))} /><Metric label="估算成本" value={money(summary?.providerEstimatedCostUSD ?? 0)} /><Metric label="活跃天数" value={number(summary?.activeDays ?? 0)} /></div><div className="overflow-hidden rounded-2xl border border-slate-200 bg-white"><div className="border-b border-slate-100 px-5 py-4 font-semibold">用量明细</div><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-5 py-3">时间</th><th className="px-5 py-3">模型</th><th className="px-5 py-3">Workspace</th><th className="px-5 py-3">输入</th><th className="px-5 py-3">输出</th><th className="px-5 py-3">估算成本</th></tr></thead><tbody>{records.map((record) => <tr key={`${record.eventId}-${record.model}`} className="border-t border-slate-100"><td className="px-5 py-3 text-slate-500">{new Date(record.createdAt).toLocaleString()}</td><td className="px-5 py-3 font-medium">{record.model}</td><td className="max-w-[220px] truncate px-5 py-3 text-slate-500">{record.workspaceJid}</td><td className="px-5 py-3">{number(record.inputTokens)}</td><td className="px-5 py-3">{number(record.outputTokens)}</td><td className="px-5 py-3">{money(record.providerEstimatedCostUSD)}</td></tr>)}{!records.length && <tr><td colSpan={6} className="px-5 py-10 text-center text-slate-400">当前筛选范围没有用量记录。</td></tr>}</tbody></table></div></div></>}
  </section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl border border-slate-200 bg-white p-4"><div className="text-xs text-slate-400">{label}</div><div className="mt-2 text-lg font-semibold text-slate-900">{value}</div></div>; }
