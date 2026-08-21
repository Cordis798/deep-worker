import { useEffect, useState } from 'react';
import { api, apiFetch, getErrorMessage } from '../api/client.js';
import { useWorkspaceStore } from '../stores/workspaces.js';

interface Memory { id: string; kind: 'fact' | 'decision' | 'experience' | 'follow_up'; title: string; content: string; source: string; revision: number; updated_at: string; }

export function MemoryPage() {
  const workspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [query, setQuery] = useState('');
  const [form, setForm] = useState({ kind: 'fact' as Memory['kind'], title: '', content: '' });
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!workspaceId) return;
    try {
      const path = query.trim() ? `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/search?q=${encodeURIComponent(query)}` : `/api/workspaces/${encodeURIComponent(workspaceId)}/memory`;
      const data = await api.get<{ memories: Memory[] }>(path);
      setMemories(data.memories);
    } catch (reason) { setError(getErrorMessage(reason, '加载记忆失败')); }
  }

  useEffect(() => { void load(); }, [workspaceId]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId) return;
    try {
      await api.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory`, { ...form, source: 'web_user' });
      setForm({ kind: 'fact', title: '', content: '' });
      await load();
    } catch (reason) { setError(getErrorMessage(reason, '创建记忆失败')); }
  }

  async function remove(memory: Memory) {
    if (!workspaceId) return;
    try { await apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory/${memory.id}`, { method: 'DELETE', body: JSON.stringify({ expected_revision: memory.revision }) }); await load(); } catch (reason) { setError(getErrorMessage(reason, '删除记忆失败')); }
  }

  if (!workspaceId) return <div className="p-6"><div className="rounded-3xl border border-slate-200 bg-white p-10 text-center"><h2 className="text-xl font-semibold">先选择工作区</h2><p className="mt-2 text-sm text-slate-500">记忆按工作区隔离。</p></div></div>;
  return <section className="mx-auto w-full max-w-7xl p-4 sm:p-6"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-semibold">工作区记忆</h2><p className="mt-1 text-sm text-slate-500">事实、决定、经验和待跟进事项，修改需要基于当前版本。</p></div><form onSubmit={(event) => { event.preventDefault(); void load(); }} className="flex gap-2"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索记忆" className="rounded-xl border border-slate-200 px-3 py-2 text-sm" /><button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">搜索</button></form></div>{error && <div role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}<form onSubmit={create} className="mt-5 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-[140px_220px_minmax(0,1fr)_auto]"><select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as Memory['kind'] })} className="rounded-xl border border-slate-200 px-3 py-2 text-sm"><option value="fact">事实</option><option value="decision">决定</option><option value="experience">经验</option><option value="follow_up">待跟进</option></select><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="标题" className="rounded-xl border border-slate-200 px-3 py-2 text-sm" /><textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} placeholder="内容" rows={1} className="resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm" /><button className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">保存记忆</button></form><div className="mt-5 grid gap-3 md:grid-cols-2">{memories.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-400 md:col-span-2">暂无记忆</div> : memories.map((memory) => <article key={memory.id} className="rounded-2xl border border-slate-200 bg-white p-4"><div className="flex items-start justify-between gap-3"><div><span className="rounded-full bg-indigo-50 px-2 py-1 text-xs text-indigo-700">{memory.kind}</span><h3 className="mt-3 font-semibold">{memory.title || '未命名记忆'}</h3></div><button onClick={() => void remove(memory)} className="text-xs text-rose-500">删除</button></div><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{memory.content}</p><p className="mt-3 text-xs text-slate-400">版本 {memory.revision} · {memory.source} · {new Date(memory.updated_at).toLocaleString()}</p></article>)}</div></section>;
}
