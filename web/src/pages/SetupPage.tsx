import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, getErrorMessage } from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';
import { AuthPage, ErrorText, Field } from './LoginPage.js';

export function SetupPage() {
  const navigate = useNavigate();
  const setup = useAuthStore((state) => state.setup);
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void api.get<{ initialized: boolean }>('/api/auth/status').then((data) => setInitialized(data.initialized)).catch(() => setInitialized(false));
  }, []);

  useEffect(() => {
    if (initialized) navigate('/login', { replace: true });
  }, [initialized, navigate]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await setup(username, password);
      navigate('/chat', { replace: true });
    } catch (reason) {
      setError(getErrorMessage(reason, '初始化失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  }

  if (initialized === null || initialized) return <div className="grid min-h-screen place-items-center text-sm text-slate-500">正在检查系统状态…</div>;
  return <AuthPage title="初始化工作台" subtitle="创建第一个管理员账号，开始使用 Deep Worker。">
    <form onSubmit={submit} className="space-y-4">
      <Field label="管理员用户名" value={username} onChange={setUsername} autoComplete="username" />
      <Field label="管理员密码" type="password" value={password} onChange={setPassword} autoComplete="new-password" />
      {error && <ErrorText>{error}</ErrorText>}
      <button disabled={submitting} className="w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50">{submitting ? '初始化中…' : '创建管理员'}</button>
    </form>
    <p className="mt-6 text-center text-sm text-slate-500">已有管理员？ <Link className="font-semibold text-indigo-600" to="/login">前往登录</Link></p>
  </AuthPage>;
}
