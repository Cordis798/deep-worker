import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore, type Permission } from '../../stores/auth.js';

function LoadingScreen() {
  return (
    <div className="grid min-h-screen place-items-center bg-[#f6f7fb] p-6">
      <div className="rounded-2xl border border-slate-200 bg-white px-6 py-5 text-sm text-slate-500 shadow-sm" role="status">
        正在检查登录状态…
      </div>
    </div>
  );
}

export function AuthGuard({
  children,
  requiredPermission,
  requiredAnyPermissions,
}: {
  children: ReactNode;
  requiredPermission?: Permission;
  requiredAnyPermissions?: Permission[];
}) {
  const location = useLocation();
  const checked = useRef(false);
  const { checking, checkAuth, initialized, authenticated, hasPermission } = useAuthStore();

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    void checkAuth();
  }, [checkAuth]);

  if (checking || initialized === null) return <LoadingScreen />;
  if (initialized === false) return <Navigate to="/setup" replace />;
  if (!authenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  if (requiredPermission && !hasPermission(requiredPermission)) {
    return <PermissionDenied />;
  }
  if (requiredAnyPermissions && !requiredAnyPermissions.some(hasPermission)) {
    return <PermissionDenied />;
  }
  return children;
}

function PermissionDenied() {
  return (
    <div className="grid min-h-screen place-items-center bg-[#f6f7fb] p-6">
      <div className="w-full max-w-md rounded-3xl border border-rose-100 bg-white p-8 text-center shadow-sm">
        <div className="text-3xl">⛔</div>
        <h1 className="mt-4 text-xl font-semibold">没有访问权限</h1>
        <p className="mt-2 text-sm text-slate-500">当前账号没有执行此操作所需的权限。</p>
      </div>
    </div>
  );
}

export function PublicOnly({ children }: { children: ReactNode }) {
  const checked = useRef(false);
  const { checking, checkAuth, authenticated, initialized } = useAuthStore();

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    void checkAuth();
  }, [checkAuth]);

  if (checking || initialized === null) return <LoadingScreen />;
  if (authenticated) return <Navigate to="/chat" replace />;
  return children;
}
