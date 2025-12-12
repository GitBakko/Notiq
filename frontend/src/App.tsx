import { Routes, Route, Navigate } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import LoginPage from './features/auth/LoginPage';
import RegisterPage from './features/auth/RegisterPage';
import ForgotPasswordPage from './features/auth/ForgotPasswordPage';
import ResetPasswordPage from './features/auth/ResetPasswordPage';
import NotesPage from './features/notes/NotesPage';
import NotebooksPage from './features/notebooks/NotebooksPage';
import TagsPage from './features/tags/TagsPage';
import TrashPage from './features/trash/TrashPage';
import TasksPage from './features/tasks/TasksPage';
import PublicNotePage from './features/public/PublicNotePage';
import SettingsPage from './features/settings/SettingsPage';
import ProfilePage from './features/user/ProfilePage';
import VaultPage from './features/vault/VaultPage';
import SharedWithMePage from './features/sharing/SharedWithMePage';
import RespondToShare from './pages/RespondToShare';

import { Toaster } from 'react-hot-toast';

function App() {
  return (
    <>
      <Toaster
        position="bottom-right"
        toastOptions={{
          success: {
            style: {
              background: '#10b981',
              color: '#fff',
            },
          },
        }}
      />
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Navigate to="notes" replace />} />
          <Route path="notes" element={<NotesPage />} />
          <Route path="notebooks" element={<NotebooksPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="tags" element={<TagsPage />} />
          <Route path="trash" element={<TrashPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="vault" element={<VaultPage />} />
          <Route path="shared" element={<SharedWithMePage />} />
        </Route>

        {/* Public Routes */}
        <Route path="public/notes/:noteId" element={<PublicNotePage />} />
        <Route path="share/respond" element={<RespondToShare />} />

        {/* Auth Routes */}
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="forgot-password" element={<ForgotPasswordPage />} />
        <Route path="reset-password" element={<ResetPasswordPage />} />

        {/* Catch all - redirect to notes or a 404 page */}
        <Route path="*" element={<Navigate to="notes" replace />} />
      </Routes>
    </>
  );
}

export default App;
