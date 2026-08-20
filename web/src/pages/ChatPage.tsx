import { useEffect, useMemo, useState } from 'react';
import { MarkdownText } from '../components/chat/MarkdownText.js';
import { useChatStore } from '../stores/chat.js';
import { useWorkspaceStore } from '../stores/workspaces.js';

export function ChatPage() {
  const { workspaces, sessions, mounts, currentWorkspaceId, currentSessionId, load, selectWorkspace, selectSession, createWorkspace, createSession, loading, error } = useWorkspaceStore();
  const messages = useChatStore((state) => currentSessionId ? state.messages[currentSessionId] ?? [] : []);
  const active = useChatStore((state) => currentSessionId ? state.activeTurns[currentSessionId] : undefined);
  const sendError = useChatStore((state) => currentSessionId ? state.sendError[currentSessionId] : null);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const stopMessage = useChatStore((state) => state.stopMessage);
  const [draft, setDraft] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [sessionName, setSessionName] = useState('');

  useEffect(() => { void load(); }, [load]);
  const currentWorkspace = workspaces.find((item) => item.jid === currentWorkspaceId);
  const currentSessions = currentWorkspaceId ? sessions[currentWorkspaceId] ?? [] : [];
  const currentMounts = currentWorkspaceId ? mounts[currentWorkspaceId] ?? [] : [];
  const canSend = !!currentWorkspaceId && !!currentSessionId && !active;

  async function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!currentWorkspaceId || !currentSessionId || !draft.trim() || active) return;
    const content = draft;
    setDraft('');
    await sendMessage(currentWorkspaceId, currentSessionId, content);
  }

  async function addWorkspace(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceName.trim()) return;
    await createWorkspace(workspaceName.trim());
    setWorkspaceName('');
  }

  async function addSession(event: React.FormEvent) {
    event.preventDefault();
    if (!currentWorkspaceId || !sessionName.trim()) return;
    await createSession(currentWorkspaceId, sessionName.trim());
    setSessionName('');
  }

  return (
    <div className="grid min-h-full grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-white p-4 lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between"><h2 className="font-semibold">Workspace</h2><span className="text-xs text-slate-400">{workspaces.length}</span></div>
        <div className="mt-3 space-y-1">
          {workspaces.map((workspace) => <button key={workspace.jid} onClick={() => void selectWorkspace(workspace.jid)} className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm ${workspace.jid === currentWorkspaceId ? 'bg-indigo-50 font-semibold text-indigo-700' : 'text-slate-600 hover:bg-slate-50'}`}><span className="truncate">{workspace.name}</span>{workspace.is_home && <span className="text-[10px] text-slate-400">HOME</span>}</button>)}
          {!workspaces.length && !loading && <p className="rounded-xl bg-slate-50 px-3 py-4 text-xs text-slate-500">暂无工作区</p>}
        </div>
        <form onSubmit={addWorkspace} className="mt-3 flex gap-2"><input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="新工作区名称" className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2.5 py-2 text-xs outline-none focus:border-indigo-500" /><button className="rounded-lg bg-slate-950 px-3 text-xs text-white">新增</button></form>
        <div className="my-5 border-t border-slate-100" />
        <div className="flex items-center justify-between"><h2 className="font-semibold">Session</h2><span className="text-xs text-slate-400">{currentSessions.length}</span></div>
        <div className="mt-3 space-y-1">
          {currentSessions.map((session) => <button key={session.id} onClick={() => selectSession(session.id)} className={`w-full rounded-xl px-3 py-2 text-left text-sm ${session.id === currentSessionId ? 'bg-slate-950 text-white' : 'text-slate-600 hover:bg-slate-50'}`}><span className="block truncate">{session.name}</span><span className={`mt-0.5 block text-[10px] ${session.id === currentSessionId ? 'text-slate-300' : 'text-slate-400'}`}>{session.status === 'active' ? '活跃' : '已归档'}</span></button>)}
          {currentWorkspaceId && !currentSessions.length && <p className="rounded-xl bg-slate-50 px-3 py-4 text-xs text-slate-500">暂无会话</p>}
        </div>
        {currentWorkspaceId && <form onSubmit={addSession} className="mt-3 flex gap-2"><input value={sessionName} onChange={(event) => setSessionName(event.target.value)} placeholder="新会话名称" className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2.5 py-2 text-xs outline-none focus:border-indigo-500" /><button className="rounded-lg bg-indigo-600 px-3 text-xs text-white">新增</button></form>}
        {currentWorkspace && <div className="mt-5 rounded-2xl bg-slate-50 p-3 text-xs text-slate-500"><div className="font-medium text-slate-700">当前工作区</div><div className="mt-1 truncate">目录：{currentWorkspace.folder}</div><div className="mt-1">渠道绑定：{currentMounts.length} 个</div></div>}
      </aside>
      <section className="flex min-h-[calc(100vh-4rem)] min-w-0 flex-col">
        <div className="border-b border-slate-200 bg-white px-4 py-4 sm:px-6"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">{currentSessionId ? currentSessions.find((session) => session.id === currentSessionId)?.name : '选择一个会话'}</h2><p className="mt-1 text-xs text-slate-400">{currentWorkspace?.name ?? '先创建或选择工作区'}</p></div>{active && <button onClick={() => currentSessionId && stopMessage(currentSessionId)} className="rounded-xl border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50">停止生成</button>}</div></div>
        <div className="flex-1 space-y-4 overflow-auto p-4 sm:p-6">
          {error && <div role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
          {!currentSessionId && <EmptyChat />}
          {currentSessionId && messages.length === 0 && <div className="mx-auto mt-16 max-w-md text-center"><div className="text-4xl">✦</div><h3 className="mt-4 text-xl font-semibold">开始一段新对话</h3><p className="mt-2 text-sm text-slate-500">消息会通过 Pi Runner 流式返回，工具轨迹会显示在回复下方。</p></div>}
          {messages.map((message) => <Message key={message.id} message={message} />)}
          {sendError && <div role="alert" className="mx-auto max-w-3xl rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700">{sendError}</div>}
        </div>
        <form onSubmit={submitMessage} className="border-t border-slate-200 bg-white p-3 sm:p-5"><div className="mx-auto flex max-w-4xl items-end gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-2 shadow-sm focus-within:border-indigo-400 focus-within:ring-4 focus-within:ring-indigo-500/10"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitMessage(event); } }} disabled={!canSend} rows={2} placeholder={canSend ? '输入消息，Enter 发送，Shift+Enter 换行' : '请先选择一个可用会话'} className="min-h-12 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none disabled:cursor-not-allowed" /><button disabled={!canSend || !draft.trim()} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">发送</button></div></form>
      </section>
    </div>
  );
}

function EmptyChat() { return <div className="mx-auto mt-16 max-w-md text-center"><div className="text-4xl">◈</div><h3 className="mt-4 text-xl font-semibold">还没有可用会话</h3><p className="mt-2 text-sm text-slate-500">从左侧创建工作区和会话后，就可以开始聊天。</p></div>; }

function Message({ message }: { message: import('../stores/chat.js').ChatMessage }) {
  const tools = useMemo(() => message.events.filter((event) => event.eventType === 'tool_use_start' || event.eventType === 'tool_result'), [message.events]);
  const isUser = message.role === 'user';
  return <div className={`mx-auto flex w-full max-w-3xl ${isUser ? 'justify-end' : 'justify-start'}`}><article className={`max-w-[90%] rounded-2xl px-4 py-3 sm:max-w-[80%] ${isUser ? 'bg-slate-950 text-white' : 'border border-slate-200 bg-white text-slate-700 shadow-sm'}`}><div className="mb-1 text-[11px] font-semibold uppercase tracking-wider opacity-50">{isUser ? '你' : 'Pi Agent'}</div>{!isUser && message.thinking && <div className="mb-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-500">思考：{message.thinking}</div>}<MarkdownText text={message.text || (message.status === 'streaming' ? '正在生成…' : '')} />{tools.length > 0 && <div className="mt-3 space-y-1 border-t border-slate-100 pt-2">{tools.map((event, index) => <div key={`${event.toolUseId ?? 'tool'}-${index}`} className="flex items-center gap-2 text-xs text-slate-500"><span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">{event.toolName ?? '工具'}</span><span>{event.eventType === 'tool_result' ? event.toolResult ?? '已完成' : '执行中'}</span></div>)}</div>}<div className="mt-2 text-[10px] opacity-40">{message.status === 'streaming' ? '生成中' : message.status === 'error' ? '失败' : message.status === 'stopped' ? '已停止' : ''}</div></article></div>;
}
