import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

const navItems = [
  { to: '/chat', label: '聊天', icon: '◈' },
  { to: '/agent-profiles', label: 'Agent', icon: '✦' },
  { to: '/files', label: '文件', icon: '▱' },
  { to: '/terminal', label: '终端', icon: '⌘' },
  { to: '/tasks', label: '任务', icon: '◷' },
  { to: '/memory', label: '记忆', icon: '◇' },
  { to: '/settings', label: '设置', icon: '⚙' },
];

const adminItems = [
  { to: '/monitor', label: '监控', icon: '◌' },
  { to: '/users', label: '用户', icon: '◎' },
];

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const location = useLocation();
  const renderItem = (item: (typeof navItems)[number]) => (
    <NavLink
      key={item.to}
      to={item.to}
      onClick={onNavigate}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
          isActive || (item.to === '/chat' && location.pathname.startsWith('/chat'))
            ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
        }`
      }
    >
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-current/10 text-base">{item.icon}</span>
      <span>{item.label}</span>
    </NavLink>
  );

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-slate-200 bg-white px-4 py-5">
      <div className="mb-8 flex items-center gap-3 px-2">
        <div className="grid h-10 w-10 place-items-center rounded-2xl bg-slate-950 text-lg text-white">DW</div>
        <div>
          <div className="font-semibold tracking-tight text-slate-950">Deep Worker</div>
          <div className="text-xs text-slate-400">Pi 工作台</div>
        </div>
      </div>
      <nav aria-label="主导航" className="space-y-1">
        {navItems.map(renderItem)}
      </nav>
      <div className="my-5 border-t border-slate-100" />
      <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">管理</div>
      <nav aria-label="管理导航" className="space-y-1">
        {adminItems.map(renderItem)}
      </nav>
      <div className="mt-auto rounded-2xl bg-slate-50 p-3 text-xs text-slate-500">
        <div className="flex items-center justify-between">
          <span>运行状态</span>
          <span className="flex items-center gap-1.5 text-emerald-600"><span className="h-2 w-2 rounded-full bg-emerald-500" />在线</span>
        </div>
        <div className="mt-2 text-slate-400">本地 Pi Runner</div>
      </div>
    </aside>
  );
}

export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const title = navItems.concat(adminItems).find((item) => location.pathname.startsWith(item.to))?.label ?? '工作台';

  return (
    <div className="min-h-screen bg-[#f6f7fb] text-slate-950">
      <div className="flex min-h-screen">
        <div className="hidden md:block"><Sidebar onNavigate={() => undefined} /></div>
        {mobileOpen && (
          <button className="fixed inset-0 z-30 bg-slate-950/30 md:hidden" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />
        )}
        <div className={`fixed inset-y-0 left-0 z-40 transition-transform md:hidden ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <Sidebar onNavigate={() => setMobileOpen(false)} />
        </div>
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white/80 px-4 backdrop-blur sm:px-6">
            <div className="flex items-center gap-3">
              <button className="rounded-xl border border-slate-200 px-3 py-2 text-sm md:hidden" onClick={() => setMobileOpen(true)} aria-label="打开导航">☰</button>
              <div>
                <div className="text-xs text-slate-400">工作台</div>
                <h1 className="font-semibold">{title}</h1>
              </div>
            </div>
            <div className="flex items-center gap-3 text-sm text-slate-500">
              <span className="hidden sm:inline">本地会话</span>
              <div className="grid h-9 w-9 place-items-center rounded-full bg-indigo-100 font-semibold text-indigo-700">U</div>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-auto"><Outlet /></div>
        </main>
      </div>
    </div>
  );
}
