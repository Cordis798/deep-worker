import {
  Navigate,
  Route,
  RouterProvider,
  createBrowserRouter,
  createRoutesFromElements,
} from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout.js';
import { RoutePlaceholder } from './pages/RoutePlaceholder.js';

const routes = createRoutesFromElements(
  <>
    <Route path="/login" element={<RoutePlaceholder title="登录" />} />
    <Route path="/register" element={<RoutePlaceholder title="注册" />} />
    <Route path="/setup" element={<RoutePlaceholder title="初始化管理员" />} />
    <Route path="/setup/providers" element={<RoutePlaceholder title="配置 Provider" />} />
    <Route path="/setup/channels" element={<RoutePlaceholder title="配置渠道" />} />
    <Route element={<AppLayout />}>
      <Route path="/chat/:workspaceId?" element={<RoutePlaceholder title="聊天" />} />
      <Route path="/groups" element={<Navigate to="/chat" replace />} />
      <Route path="/agent-profiles" element={<RoutePlaceholder title="Agent 管理" />} />
      <Route path="/files" element={<RoutePlaceholder title="文件" />} />
      <Route path="/terminal" element={<RoutePlaceholder title="终端" />} />
      <Route path="/settings" element={<RoutePlaceholder title="设置" />} />
      <Route path="/monitor" element={<RoutePlaceholder title="监控" />} />
      <Route path="/users" element={<RoutePlaceholder title="用户管理" />} />
      <Route path="/capabilities/:section?" element={<RoutePlaceholder title="能力" />} />
      <Route path="/tasks" element={<RoutePlaceholder title="任务" />} />
      <Route path="/memory" element={<RoutePlaceholder title="记忆" />} />
      <Route path="/usage" element={<RoutePlaceholder title="用量" />} />
      <Route path="/billing" element={<RoutePlaceholder title="计费" />} />
      <Route path="/skills" element={<Navigate to="/capabilities/skills" replace />} />
      <Route path="/mcp-servers" element={<Navigate to="/capabilities/mcp" replace />} />
      <Route path="/plugins" element={<Navigate to="/capabilities/plugins" replace />} />
    </Route>
    <Route path="/" element={<Navigate to="/chat" replace />} />
    <Route path="*" element={<Navigate to="/chat" replace />} />
  </>,
);

export function createAppRouter() {
  return createBrowserRouter(routes);
}

export function App() {
  return <RouterProvider router={createAppRouter()} />;
}
