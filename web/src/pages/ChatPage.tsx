import { useEffect, useMemo, useState } from 'react';
import { MarkdownText } from '../components/chat/MarkdownText.js';
import { selectSessionMessages, useChatStore, type ChatMessage } from '../stores/chat.js';
import { useWorkspaceStore } from '../stores/workspaces.js';
import { useAgentRouterStore } from '../stores/agentRouter.js';

export function ChatPage() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const sessions = useWorkspaceStore((state) => state.sessions);
  const mounts = useWorkspaceStore((state) => state.mounts);
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const currentSessionId = useWorkspaceStore((state) => state.currentSessionId);
  const load = useWorkspaceStore((state) => state.load);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const selectSession = useWorkspaceStore((state) => state.selectSession);
  const createWorkspace = useWorkspaceStore((state) => state.createWorkspace);
  const createSession = useWorkspaceStore((state) => state.createSession);
  const copySession = useWorkspaceStore((state) => state.copySession);
  const access = useWorkspaceStore((state) => currentWorkspaceId ? state.access[currentWorkspaceId] : undefined);
  const loading = useWorkspaceStore((state) => state.loading);
  const error = useWorkspaceStore((state) => state.error);
  const messages = useChatStore((state) => selectSessionMessages(state, currentSessionId));
  const active = useChatStore((state) =>
    currentSessionId ? state.activeTurns[currentSessionId] : undefined,
  );
  const sendError = useChatStore((state) =>
    currentSessionId ? state.sendError[currentSessionId] : null,
  );
  const sendMessage = useChatStore((state) => state.sendMessage);
  const stopMessage = useChatStore((state) => state.stopMessage);
  const [draft, setDraft] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [routerOpen, setRouterOpen] = useState(false);
  const [routerDraft, setRouterDraft] = useState('');
  const routerPlans = useAgentRouterStore((state) => currentWorkspaceId ? state.plans[currentWorkspaceId] ?? [] : []);
  const routerError = useAgentRouterStore((state) => state.error);
  const loadRouter = useAgentRouterStore((state) => state.load);
  const createRouterPlan = useAgentRouterStore((state) => state.createPlan);
  const dispatchRouterPlan = useAgentRouterStore((state) => state.dispatch);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (currentWorkspaceId) void loadRouter(currentWorkspaceId);
  }, [currentWorkspaceId, loadRouter]);
  const currentWorkspace = workspaces.find((item) => item.jid === currentWorkspaceId);
  const currentSessions = currentWorkspaceId ? (sessions[currentWorkspaceId] ?? []) : [];
  const currentMounts = currentWorkspaceId ? (mounts[currentWorkspaceId] ?? []) : [];
  const canSend = !!currentWorkspaceId && !!currentSessionId && !active && (access?.actions.converse ?? true);

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

  async function createRouter(event: React.FormEvent) {
    event.preventDefault();
    if (!currentWorkspaceId || !routerDraft.trim()) return;
    await createRouterPlan(currentWorkspaceId, routerDraft.trim());
    setRouterDraft('');
  }

  return (
    <div className="grid min-h-full grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-white p-4 lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Workspace</h2>
          <span className="text-xs text-slate-400">{workspaces.length}</span>
        </div>
        <div className="mt-3 space-y-1">
          {workspaces.map((workspace) => (
            <button
              key={workspace.jid}
              onClick={() => void selectWorkspace(workspace.jid)}
              className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm ${workspace.jid === currentWorkspaceId ? 'bg-indigo-50 font-semibold text-indigo-700' : 'text-slate-600 hover:bg-slate-50'}`}
            >
              <span className="truncate">{workspace.name}</span>
              {workspace.is_home && <span className="text-[10px] text-slate-400">HOME</span>}
            </button>
          ))}
          {!workspaces.length && !loading && (
            <p className="rounded-xl bg-slate-50 px-3 py-4 text-xs text-slate-500">
              暂无工作区
            </p>
          )}
        </div>
        <form onSubmit={addWorkspace} className="mt-3 flex gap-2">
          <input
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            placeholder="新工作区名称"
            className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2.5 py-2 text-xs outline-none focus:border-indigo-500"
          />
          <button className="rounded-lg bg-slate-950 px-3 text-xs text-white">新增</button>
        </form>
        <div className="my-5 border-t border-slate-100" />
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Session</h2>
          <span className="text-xs text-slate-400">{currentSessions.length}</span>
        </div>
        <div className="mt-3 space-y-1">
          {currentSessions.map((session) => (
            <div key={session.id} className={`flex items-center gap-1 rounded-xl px-2 py-1 ${session.id === currentSessionId ? 'bg-slate-950 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>
              <button onClick={() => selectSession(session.id)} className="min-w-0 flex-1 py-1 text-left text-sm">
                <span className="block truncate">{session.name}</span>
                <span className={`mt-0.5 block text-[10px] ${session.id === currentSessionId ? 'text-slate-300' : 'text-slate-400'}`}>{session.status === 'active' ? '活跃' : '已归档'}</span>
              </button>
              {access?.actions.copy && <button title="复制到我的 Workspace" onClick={() => void copySession(currentWorkspaceId!, session.id)} className={`rounded-lg px-1.5 py-1 text-[10px] ${session.id === currentSessionId ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-400 hover:bg-white'}`}>复制</button>}
            </div>
          ))}
          {currentWorkspaceId && !currentSessions.length && (
            <p className="rounded-xl bg-slate-50 px-3 py-4 text-xs text-slate-500">暂无会话</p>
          )}
        </div>
        {currentWorkspaceId && (
          <form onSubmit={addSession} className="mt-3 flex gap-2">
            <input
              value={sessionName}
              onChange={(event) => setSessionName(event.target.value)}
              placeholder="新会话名称"
              className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2.5 py-2 text-xs outline-none focus:border-indigo-500"
            />
            <button className="rounded-lg bg-indigo-600 px-3 text-xs text-white">新增</button>
          </form>
        )}
        {currentWorkspace && (
          <div className="mt-5 rounded-2xl bg-slate-50 p-3 text-xs text-slate-500">
            <div className="font-medium text-slate-700">当前工作区</div>
            <div className="mt-1 truncate">目录：{currentWorkspace.folder}</div>
            <div className="mt-1">渠道绑定：{currentMounts.length} 个</div>
          </div>
        )}
      </aside>
      <section className="flex min-h-[calc(100vh-4rem)] min-w-0 flex-col">
        <div className="border-b border-slate-200 bg-white px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">
                {currentSessionId
                  ? currentSessions.find((session) => session.id === currentSessionId)?.name
                  : '选择一个会话'}
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                {currentWorkspace?.name ?? '先创建或选择工作区'}
              </p>
            </div>
            {active && (
              <button
                onClick={() => currentSessionId && stopMessage(currentSessionId)}
                className="rounded-xl border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50"
              >
                停止生成
              </button>
            )}
            {currentWorkspaceId && access?.actions.converse && (
              <button onClick={() => setRouterOpen((value) => !value)} className={`rounded-xl border px-3 py-2 text-xs font-semibold ${routerOpen ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                Agent Router · 多 Agent 编排
              </button>
            )}
          </div>
        </div>
        {routerOpen && currentWorkspaceId && (
          <div className="border-b border-indigo-100 bg-indigo-50/60 px-4 py-4 sm:px-6">
            <form onSubmit={(event) => void createRouter(event)} className="mx-auto flex max-w-4xl gap-2">
              <input value={routerDraft} onChange={(event) => setRouterDraft(event.target.value)} placeholder="输入跨岗位任务，例如：修复代码并发布上线" className="min-w-0 flex-1 rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500" />
              <button disabled={!routerDraft.trim()} className="rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">规划</button>
            </form>
            {routerError && <p className="mx-auto mt-2 max-w-4xl text-xs text-rose-600">{routerError}</p>}
            {routerPlans.slice(0, 3).map((plan) => <div key={plan.id} className="mx-auto mt-3 flex max-w-4xl items-center justify-between rounded-xl bg-white px-3 py-2 text-xs"><span><strong>{plan.intent}</strong> · {plan.route.explanation} · {plan.status}</span>{plan.status === 'planned' && <button onClick={() => void dispatchRouterPlan(currentWorkspaceId, plan.id)} className="font-semibold text-indigo-600">开始调度</button>}</div>)}
          </div>
        )}
        <div className="flex-1 space-y-4 overflow-auto p-4 sm:p-6">
          {error && (
            <div role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}
          {!currentSessionId && <EmptyChat />}
          {currentSessionId && messages.length === 0 && (
            <div className="mx-auto mt-16 max-w-md text-center">
              <div className="text-4xl">✦</div>
              <h3 className="mt-4 text-xl font-semibold">开始一段新对话</h3>
              <p className="mt-2 text-sm text-slate-500">
                消息会通过 Pi Runner 流式返回，工具轨迹会显示在回复下方。
              </p>
            </div>
          )}
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
          {sendError && (
            <div
              role="alert"
              className="mx-auto max-w-3xl rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700"
            >
              {sendError}
            </div>
          )}
        </div>
        <form
          onSubmit={submitMessage}
          data-mobile-chat="composer"
          className="border-t border-slate-200 bg-white p-3 sm:p-5"
        >
          <div className="mx-auto flex max-w-4xl items-end gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-2 shadow-sm focus-within:border-indigo-400 focus-within:ring-4 focus-within:ring-indigo-500/10">
            <textarea
              data-mobile-chat="input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submitMessage(event);
                }
              }}
              disabled={!canSend}
              rows={2}
              placeholder={
                canSend ? '输入消息，Enter 发送，Shift+Enter 换行' : '请先选择一个可用会话'
              }
              className="min-h-12 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none disabled:cursor-not-allowed"
            />
            <button
              data-mobile-chat="send"
              disabled={!canSend || !draft.trim()}
              className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              发送
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <div className="text-4xl">◈</div>
      <h3 className="mt-4 text-xl font-semibold">还没有可用会话</h3>
      <p className="mt-2 text-sm text-slate-500">从左侧创建工作区和会话后，就可以开始聊天。</p>
    </div>
  );
}

function Message({ message }: { message: import('../stores/chat.js').ChatMessage }) {
  const tools = useMemo(
    () =>
      message.events.filter(
        (event) => event.eventType === 'tool_use_start' || event.eventType === 'tool_result',
      ),
    [message.events],
  );
  const isUser = message.role === 'user';
  return (
    <div
      className={`mx-auto flex w-full max-w-3xl ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <article
        className={`max-w-[90%] rounded-2xl px-4 py-3 sm:max-w-[80%] ${isUser ? 'bg-slate-950 text-white' : 'border border-slate-200 bg-white text-slate-700 shadow-sm'}`}
      >
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider opacity-50">
          {isUser ? '你' : 'Pi Agent'}
        </div>
        {!isUser && message.thinking && (
          <div className="mb-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
            思考：{message.thinking}
          </div>
        )}
        <MarkdownText
          text={message.text || (message.status === 'streaming' ? '正在生成…' : '')}
        />
        {tools.length > 0 && (
          <div className="mt-3 space-y-1 border-t border-slate-100 pt-2">
            {tools.map((event, index) => (
              <div
                key={`${event.toolUseId ?? 'tool'}-${index}`}
                className="flex items-center gap-2 text-xs text-slate-500"
              >
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">
                  {event.toolName ?? '工具'}
                </span>
                <span>
                  {event.eventType === 'tool_result'
                    ? (event.toolResult ?? '已完成')
                    : '执行中'}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-2 text-[10px] opacity-40">
          {message.status === 'streaming'
            ? '生成中'
            : message.status === 'error'
              ? '失败'
              : message.status === 'stopped'
                ? '已停止'
                : ''}
        </div>
      </article>
    </div>
  );
}
