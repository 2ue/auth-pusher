import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import PushPage from './pages/PushPage';
import ChannelListPage from './pages/ChannelListPage';
import ChannelFormPage from './pages/ChannelFormPage';
import TaskListPage from './pages/TaskListPage';
import TaskDetailPage from './pages/TaskDetailPage';
import ProfileListPage from './pages/ProfileListPage';
import DashboardPage from './pages/DashboardPage';
import AccountPoolPage from './pages/AccountPoolPage';
import SettingsPage from './pages/SettingsPage';
import DetectPage from './pages/DetectPage';
import ConvertPage from './pages/ConvertPage';
import OpenAiOAuthPage from './pages/OpenAiOAuthPage';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/accounts" element={<AccountPoolPage />} />
        <Route path="/oauth-capture" element={<OpenAiOAuthPage />} />
        <Route path="/convert" element={<ConvertPage />} />
        <Route path="/detect" element={<DetectPage />} />
        <Route path="/push" element={<PushPage />} />
        <Route path="/channels" element={<ChannelListPage />} />
        <Route path="/channels/new" element={<ChannelFormPage />} />
        <Route path="/channels/:id" element={<ChannelFormPage />} />
        <Route path="/profiles" element={<ProfileListPage />} />
        <Route path="/tasks" element={<TaskListPage />} />
        <Route path="/tasks/:id" element={<TaskDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
