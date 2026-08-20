import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api, getErrorMessage } from '../api/client.js';

type Section = 'skills' | 'mcp' | 'plugins';
type CapabilityItem = { id: string; name: string; enabled: boolean; version?: string; source_type?: string; status?: string; transport?: string };

const sections: Array<{ key: Section; label: string }> = [
  { key: 'skills', label: 'Skills' },
  { key: 'mcp', label: 'MCP Server' },
  { key: 'plugins', label: 'Plugins' },
];

export function CapabilitiesPage() {
  const { section = 'skills' } = useParams<{ section: Section }>();
  if (!sections.some((item) => item.key === section)) return <Navigate to="/capabilities/skills" replace />;
  return <CapabilitiesSection section={section as Section} />;
}

function CapabilitiesSection({ section }: { section: Section }) {
  const [items, setItems] = useState<CapabilityItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [limit, setLimit] = useState(20);
  const [preview, setPreview] = useState<{ hash: string; count: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const endpoint = section === 'skills' ? '/api/capabilities/skills' : section === 'mcp' ? '/api/capabilities/mcp-servers' : '/api/capabilities/plugins';

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<Record<string, CapabilityItem[]>>(endpoint);
      const key = section === 'skills' ? 'skills' : section === 'mcp' ? 'mcp_servers' : 'plugins';
      const next = data[key] ?? [];
      setItems(next);
      setSelected(next.filter((item) => item.enabled).map((item) => item.id));
    } catch (cause) {
      setError(getErrorMessage(cause, '加载能力失败'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [section]);

  const selectedCount = useMemo(() => selected.length, [selected]);

  async function toggle(item: CapabilityItem) {
    try {
      const path = `${endpoint}/${encodeURIComponent(item.id)}`;
      await api.patch(path, { enabled: !item.enabled });
      await load();
    } catch (cause) { setError(getErrorMessage(cause, '更新能力失败')); }
  }

  async function refreshPreview() {
    try {
      const data = await api.post<{ preview: { hash: string; skills: { selected: unknown[] }; mcp: { selected: unknown[] }; plugins: { selected: unknown[] } } }>('/api/capabilities/preview', {
        selected_skill_ids: section === 'skills' ? selected : undefined,
        selected_mcp_ids: section === 'mcp' ? selected : undefined,
        selected_plugin_ids: section === 'plugins' ? selected : undefined,
        limits: section === 'skills' ? { maxSkills: limit } : section === 'mcp' ? { maxMcpServers: limit } : { maxPlugins: limit },
      });
      const count = data.preview.skills.selected.length + data.preview.mcp.selected.length + data.preview.plugins.selected.length;
      setPreview({ hash: data.preview.hash, count });
    } catch (cause) { setError(getErrorMessage(cause, '生成能力预览失败')); }
  }

  return (
    <section className="mx-auto w-full max-w-7xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><h2 className="text-xl font-semibold">能力中心</h2><p className="mt-1 text-sm text-slate-500">统一查看 Skills、MCP 和 Plugins 的启用状态及生效清单。</p></div>
        <Link to="/agent-builder" className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700">打开 Agent Builder</Link>
      </div>
      <nav className="flex gap-2 rounded-2xl border border-slate-200 bg-white p-2">{sections.map((item) => <Link key={item.key} to={`/capabilities/${item.key}`} className={`rounded-xl px-4 py-2 text-sm font-medium ${item.key === section ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{item.label}</Link>)}</nav>
      {error && <div role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between"><h3 className="font-semibold">{section === 'skills' ? 'Skill 目录' : section === 'mcp' ? 'MCP Server 目录' : 'Plugin 目录'}</h3><span className="text-xs text-slate-400">已启用 {selectedCount} 项</span></div>
          <div className="mt-4 space-y-2">{loading ? <p className="text-sm text-slate-400">正在加载…</p> : items.length === 0 ? <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">暂无目录项</p> : items.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3"><div className="min-w-0"><div className="truncate font-medium">{item.name}</div><div className="mt-1 text-xs text-slate-400">{item.version ? `版本 ${item.version}` : item.transport ?? item.source_type ?? item.status ?? '已登记'}</div></div><button onClick={() => void toggle(item)} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${item.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>{item.enabled ? '已启用' : '已停用'}</button></div>)}</div>
        </div>
        <aside className="rounded-2xl border border-indigo-100 bg-indigo-50 p-5"><h3 className="font-semibold text-indigo-950">动态裁剪预览</h3><p className="mt-2 text-sm leading-6 text-indigo-800">只从当前选中的能力中裁剪，解析优先级和来源 hash 保持可追踪。</p><label className="mt-5 block text-sm font-medium text-indigo-950">最多注入 {limit} 项<input type="range" min="0" max="50" value={limit} onChange={(event) => setLimit(Number(event.target.value))} className="mt-3 w-full accent-indigo-600" /></label><button onClick={() => void refreshPreview()} className="mt-5 w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700">生成预览</button>{preview && <div className="mt-4 rounded-xl bg-white/80 p-3 text-xs text-indigo-900">生效 {preview.count} 项<br />Hash {preview.hash.slice(0, 16)}…</div>}</aside>
      </div>
    </section>
  );
}
