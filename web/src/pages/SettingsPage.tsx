import { useEffect, useState } from 'react';
import { api, getErrorMessage } from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';

interface UserSession { id: string; created_at: string; expires_at: string; last_active_at: string; }

export function SettingsPage() {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [health, setHealth] = useState<'unknown' | 'ok' | 'failed'>('unknown');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.get<{ sessions: UserSession[] }>('/api/auth/sessions').then((data) => setSessions(data.sessions)).catch((reason) => setError(getErrorMessage(reason, '加载会话失败'))); void api.get('/healthz').then(() => setHealth('ok')).catch(() => setHealth('failed')); }, []);
  async function revoke(id: string) { try { await api.delete(`/api/auth/sessions/${encodeURIComponent(id)}`); setSessions((items) => items.filter((item) => item.id !== id)); } catch (reason) { setError(getErrorMessage(reason, '撤销会话失败')); } }
  return <section className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6"><div><h2 className="text-xl font-semibold">设置</h2><p className="mt-1 text-sm text-slate-500">账号、安全和本地工作台状态。</p></div>{error && <div role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}<div className="rounded-2xl border border-slate-200 bg-white p-5"><h3 className="font-semibold">账号信息</h3><div className="mt-4 grid gap-4 sm:grid-cols-2"><Info label="用户名" value={user?.username ?? '—'} /><Info label="显示名称" value={user?.display_name ?? '—'} /><Info label="角色" value={user?.role === 'admin' ? '管理员' : '成员'} /><Info label="权限" value={user?.permissions?.length ? user.permissions.join('、') : '基础权限'} /></div></div><div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between"><div><h3 className="font-semibold">服务状态</h3><p className="mt-1 text-sm text-slate-500">用于确认 Web 工作台与后端连接。</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${health === 'ok' ? 'bg-emerald-50 text-emerald-700' : health === 'failed' ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-500'}`}>{health === 'ok' ? '正常' : health === 'failed' ? '异常' : '检查中'}</span></div></div><div className="rounded-2xl border border-slate-200 bg-white p-5"><h3 className="font-semibold">登录会话</h3><div className="mt-3 space-y-2">{sessions.map((session) => <div key={session.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-3 text-sm"><div><div className="font-mono text-xs">{session.id.slice(0, 12)}…</div><div className="mt-1 text-xs text-slate-400">最近活动：{new Date(session.last_active_at).toLocaleString()}</div></div><button onClick={() => void revoke(session.id)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs hover:bg-white">撤销</button></div>)}{!sessions.length && <p className="text-sm text-slate-400">没有可展示的会话。</p>}</div></div><div className="flex justify-end"><button onClick={() => void logout()} className="rounded-xl border border-rose-200 px-4 py-2.5 text-sm font-semibold text-rose-600 hover:bg-rose-50">退出登录</button></div></section>;
}

function Info({ label, value }: { label: string; value: string }) { return <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-400">{label}</div><div className="mt-1 break-words text-sm font-medium text-slate-700">{value}</div></div>; }
