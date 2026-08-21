import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { getErrorMessage } from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const login = useAuthStore((state) => state.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(username, password);
      const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
      navigate(from && from !== '/login' ? from : '/chat', { replace: true });
    } catch (reason) {
      setError(getErrorMessage(reason, '登录失败，请检查账号和密码'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthPage title="欢迎回来" subtitle="登录 Deep Worker，继续你的工作。">
      <form onSubmit={submit} className="space-y-4">
        <Field label="用户名" value={username} onChange={setUsername} autoComplete="username" />
        <Field
          label="密码"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        {error && <ErrorText>{error}</ErrorText>}
        <button
          disabled={submitting}
          className="w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-500">
        还没有账号？{' '}
        <Link className="font-semibold text-indigo-600 hover:text-indigo-800" to="/register">
          注册
        </Link>
      </p>
    </AuthPage>
  );
}

function AuthPage({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top_left,#e0e7ff,transparent_40%),#f8fafc] p-5">
      <section className="w-full max-w-md rounded-[2rem] border border-white/80 bg-white/90 p-7 shadow-xl shadow-indigo-950/10 backdrop-blur sm:p-9">
        <div className="mb-8 flex items-center gap-3">
          <img className="h-11 w-11 rounded-2xl" src="/icon.svg" alt="Deep Worker 标志" />
          <div className="font-semibold">Deep Worker</div>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">{subtitle}</p>
        <div className="mt-7">{children}</div>
      </section>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block text-sm font-medium text-slate-700">
      <span>{label}</span>
      <input
        required
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 outline-none transition placeholder:text-slate-300 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
      />
    </label>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
      {children}
    </p>
  );
}

export { AuthPage, ErrorText, Field };
