import {
  Navigate,
  Route,
  RouterProvider,
  createBrowserRouter,
  createRoutesFromElements,
} from 'react-router-dom';
import { AuthGuard, PublicOnly } from './components/auth/AuthGuard.js';
import { AppLayout } from './components/layout/AppLayout.js';
import { LoginPage } from './pages/LoginPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { RoutePlaceholder } from './pages/RoutePlaceholder.js';
import { CapabilitiesPage } from './pages/CapabilitiesPage.js';
import { AgentBuilderPage } from './pages/AgentBuilderPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { ChatPage } from './pages/ChatPage.js';
import { FilesPage } from './pages/FilesPage.js';
import { TerminalPage } from './pages/TerminalPage.js';
import { AgentProfilesPage } from './pages/AgentProfilesPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { MonitorPage } from './pages/MonitorPage.js';
import { UsersPage } from './pages/UsersPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { MemoryPage } from './pages/MemoryPage.js';

const routes = createRoutesFromElements(
  <>
    <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
    <Route path="/register" element={<PublicOnly><RegisterPage /></PublicOnly>} />
    <Route path="/setup" element={<SetupPage />} />
    <Route path="/setup/providers" element={<AuthGuard><RoutePlaceholder title="配置 Provider" /></AuthGuard>} />
    <Route path="/setup/channels" element={<AuthGuard><RoutePlaceholder title="配置渠道" /></AuthGuard>} />
    <Route element={<AuthGuard><AppLayout /></AuthGuard>}>
      <Route path="/chat/:workspaceId?" element={<ChatPage />} />
      <Route path="/groups" element={<Navigate to="/chat" replace />} />
      <Route path="/agent-profiles" element={<AgentProfilesPage />} />
      <Route path="/files" element={<FilesPage />} />
      <Route path="/terminal" element={<TerminalPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/monitor" element={<AuthGuard requiredPermission="manage_system_config"><MonitorPage /></AuthGuard>} />
      <Route path="/users" element={<AuthGuard requiredAnyPermissions={['manage_users', 'manage_invites', 'view_audit_log']}><UsersPage /></AuthGuard>} />
      <Route path="/capabilities/:section?" element={<CapabilitiesPage />} />
      <Route path="/agent-builder" element={<AgentBuilderPage />} />
      <Route path="/tasks" element={<TasksPage />} />
      <Route path="/memory" element={<MemoryPage />} />
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
