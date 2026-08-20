import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getErrorMessage } from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';
import { AuthPage, ErrorText, Field } from './LoginPage.js';

export function RegisterPage() {
  const navigate = useNavigate();
  const register = useAuthStore((state) => state.register);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await register({ username, password, display_name: displayName || undefined, invite_code: inviteCode || undefined });
      navigate('/chat', { replace: true });
    } catch (reason) {
      setError(getErrorMessage(reason, '注册失败，请检查填写内容'));
    } finally {
      setSubmitting(false);
    }
  }

  return <AuthPage title="创建账号" subtitle="建立一个新的工作台账号。">
    <form onSubmit={submit} className="space-y-4">
      <Field label="用户名" value={username} onChange={setUsername} autoComplete="username" />
      <Field label="显示名称（可选）" value={displayName} onChange={setDisplayName} autoComplete="name" />
      <Field label="密码" type="password" value={password} onChange={setPassword} autoComplete="new-password" />
      <Field label="邀请码（如有要求）" value={inviteCode} onChange={setInviteCode} />
      {error && <ErrorText>{error}</ErrorText>}
      <button disabled={submitting} className="w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50">{submitting ? '注册中…' : '注册'}</button>
    </form>
    <p className="mt-6 text-center text-sm text-slate-500">已有账号？ <Link className="font-semibold text-indigo-600" to="/login">返回登录</Link></p>
  </AuthPage>;
}
