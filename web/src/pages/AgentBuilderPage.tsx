import { useState } from 'react';
import { api, getErrorMessage } from '../api/client.js';

type Draft = { id: string; status: string; confirmation_required: boolean; definition: { name: string } };

export function AgentBuilderPage() {
  const [name, setName] = useState('新助手');
  const [identity, setIdentity] = useState('帮助用户完成工作。');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [code, setCode] = useState('');
  const [actionId, setActionId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveDraft() {
    try {
      const data = await api.post<{ draft: Draft }>('/api/capabilities/agent-builder/drafts', { title: name, definition: { name, identity_prompt: identity, prompt_mode: 'append' } });
      setDraft(data.draft); setMessage('草稿已保存'); setError(null);
    } catch (cause) { setError(getErrorMessage(cause, '保存草稿失败')); }
  }

  async function prepare() {
    if (!draft) return;
    try {
      const data = await api.post<{ draft: Draft; confirmation_code: string; action_id: string }>(`/api/capabilities/agent-builder/drafts/${draft.id}/prepare`, {});
      setDraft(data.draft); setCode(data.confirmation_code); setActionId(data.action_id); setMessage(`请复制一次性口令：${data.confirmation_code}`); setError(null);
    } catch (cause) { setError(getErrorMessage(cause, '准备发布失败')); }
  }

  async function publish() {
    if (!draft) return;
    try {
      await api.post(`/api/capabilities/agent-builder/drafts/${draft.id}/publish`, { confirmation_code: code, action_id: `${actionId}-confirm` });
      setMessage('Agent 已发布'); setError(null);
    } catch (cause) { setError(getErrorMessage(cause, '发布失败')); }
  }

  return <section className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6"><div><h2 className="text-xl font-semibold">Agent Builder</h2><p className="mt-1 text-sm text-slate-500">通过多轮草稿和一次性确认口令创建或更新 Agent。</p></div>{error && <div role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}{message && <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}<div className="rounded-2xl border border-slate-200 bg-white p-5"><label className="block text-sm font-medium">名称<input value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5" /></label><label className="mt-4 block text-sm font-medium">身份 Prompt<textarea value={identity} onChange={(event) => setIdentity(event.target.value)} rows={6} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-mono text-sm" /></label><div className="mt-5 flex flex-wrap justify-end gap-2"><button onClick={() => void saveDraft()} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium">保存草稿</button><button disabled={!draft} onClick={() => void prepare()} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40">准备发布</button></div></div>{draft?.confirmation_required && <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5"><h3 className="font-semibold text-amber-950">确认发布</h3><p className="mt-2 text-sm text-amber-800">请确认草稿内容后输入一次性口令。发布会消费口令，不能重复使用。</p><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="确认发布-XXXXXX" className="mt-4 w-full rounded-xl border border-amber-200 bg-white px-3 py-2.5" /><button onClick={() => void publish()} className="mt-4 w-full rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white">确认并发布</button></div>}</section>;
}
