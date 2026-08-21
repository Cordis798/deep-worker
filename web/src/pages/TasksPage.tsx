import { useEffect, useState } from 'react';
import { api, getErrorMessage } from '../api/client.js';
import { useWorkspaceStore } from '../stores/workspaces.js';

interface Task {
  id: string;
  workspace_jid: string;
  name: string;
  execution_type: 'agent' | 'script';
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  prompt: string;
  script_command: string | null;
  context_mode: 'group' | 'isolated';
  status: string;
  next_run_at: string | null;
  revision: number;
}

interface Run {
  id: string;
  status: string;
  attempt: number;
  result_text: string | null;
  error: string | null;
  duration_ms: number | null;
  notification_status: string;
  created_at: string;
}

export function TasksPage() {
  const workspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Record<string, Run[]>>({});
  const [form, setForm] = useState({ name: '', prompt: '', scheduleValue: '60000' });
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await api.get<{ tasks: Task[] }>('/api/tasks');
      setTasks(data.tasks);
    } catch (reason) {
      setError(getErrorMessage(reason, '加载任务失败'));
    }
  }

  useEffect(() => { void load(); }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId) return;
    try {
      await api.post('/api/tasks', {
        workspace_jid: workspaceId,
        name: form.name,
        execution_type: 'agent',
        schedule_type: 'interval',
        schedule_value: form.scheduleValue,
        prompt: form.prompt,
        context_mode: 'isolated',
      });
      setForm({ name: '', prompt: '', scheduleValue: '60000' });
      await load();
    } catch (reason) { setError(getErrorMessage(reason, '创建任务失败')); }
  }

  async function run(task: Task) {
    try {
      await api.post(`/api/tasks/${task.id}/run`, { idempotency_key: `web-${crypto.randomUUID()}` });
      await loadRuns(task.id);
    } catch (reason) { setError(getErrorMessage(reason, '启动任务失败')); }
  }

  async function toggle(task: Task) {
    try {
      await api.patch(`/api/tasks/${task.id}`, { expected_revision: task.revision, status: task.status === 'paused' ? 'active' : 'paused' });
      await load();
    } catch (reason) { setError(getErrorMessage(reason, '更新任务失败')); }
  }

  async function edit(task: Task) {
    const name = window.prompt('任务名称', task.name);
    if (!name?.trim()) return;
    const prompt = window.prompt('智能体提示词', task.prompt);
    if (prompt === null) return;
    try {
      await api.patch(`/api/tasks/${task.id}`, { expected_revision: task.revision, name: name.trim(), prompt });
      await load();
    } catch (reason) { setError(getErrorMessage(reason, '编辑任务失败')); }
  }

  async function stop(task: Task) {
    try { await api.post(`/api/tasks/${task.id}/stop`); await loadRuns(task.id); } catch (reason) { setError(getErrorMessage(reason, '停止任务失败')); }
  }

  async function remove(task: Task) {
    if (!window.confirm(`确认删除任务“${task.name}”吗？`)) return;
    try { await api.delete(`/api/tasks/${task.id}`); await load(); } catch (reason) { setError(getErrorMessage(reason, '删除任务失败')); }
  }

  async function loadRuns(taskId: string) {
    try {
      const data = await api.get<{ runs: Run[] }>(`/api/tasks/${taskId}/runs`);
      setRuns((current) => ({ ...current, [taskId]: data.runs }));
    } catch (reason) { setError(getErrorMessage(reason, '加载运行记录失败')); }
  }

  return <section className="mx-auto w-full max-w-7xl p-4 sm:p-6">
    <div className="flex items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">定时任务</h2><p className="mt-1 text-sm text-slate-500">任务状态、运行记录和通知状态都保存在服务端。</p></div><button onClick={() => void load()} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">刷新</button></div>
    {error && <div role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
    <form onSubmit={create} className="mt-5 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 md:grid-cols-[180px_minmax(0,1fr)_130px_auto]"><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="任务名称" className="rounded-xl border border-slate-200 px-3 py-2 text-sm" /><input value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} placeholder="智能体提示词" className="rounded-xl border border-slate-200 px-3 py-2 text-sm" /><input value={form.scheduleValue} onChange={(event) => setForm({ ...form, scheduleValue: event.target.value })} aria-label="间隔毫秒数" className="rounded-xl border border-slate-200 px-3 py-2 text-sm" /><button disabled={!workspaceId} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">创建任务</button></form>
    <div className="mt-5 space-y-3">{tasks.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-400">暂无任务</div> : tasks.map((task) => <article key={task.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">{task.name}</h3><p className="mt-1 text-xs text-slate-400">{task.schedule_type} · {task.schedule_value} · {task.context_mode} · {task.status}</p></div><div className="flex flex-wrap gap-2"><button onClick={() => void run(task)} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white">立即运行</button><button onClick={() => void toggle(task)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs">{task.status === 'paused' ? '恢复' : '暂停'}</button><button onClick={() => void edit(task)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs">编辑</button><button onClick={() => void stop(task)} className="rounded-lg border border-amber-200 px-3 py-1.5 text-xs text-amber-700">停止</button><button onClick={() => void loadRuns(task.id)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs">运行记录</button><button onClick={() => void remove(task)} className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs text-rose-600">删除</button></div></div>{runs[task.id] && <div className="mt-4 overflow-auto rounded-xl bg-slate-50 p-3 text-xs">{runs[task.id].length === 0 ? <span className="text-slate-400">暂无记录</span> : runs[task.id].map((run) => <div key={run.id} className="border-b border-slate-200 py-2 last:border-0"><div className="flex flex-wrap justify-between gap-2"><span>{run.status} · 尝试 {run.attempt} · 通知 {run.notification_status}</span><span className="text-slate-400">{new Date(run.created_at).toLocaleString()}</span></div>{run.result_text && <p className="mt-1 whitespace-pre-wrap text-slate-600">{run.result_text}</p>}{run.error && <p className="mt-1 text-rose-600">{run.error}</p>}</div>)}</div>}</article>)}</div>
  </section>;
}
