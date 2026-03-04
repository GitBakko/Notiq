import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import PageLoader from './components/ui/PageLoader';

import { Toaster } from 'react-hot-toast';

// Protected pages
const NotesPage = lazy(() => import('./features/notes/NotesPage'));
const NotebooksPage = lazy(() => import('./features/notebooks/NotebooksPage'));
const RemindersPage = lazy(() => import('./features/reminders/RemindersPage'));
const TaskListsPage = lazy(() => import('./features/tasks/TaskListsPage'));
const KanbanPage = lazy(() => import('./features/kanban/KanbanPage'));
const TagsPage = lazy(() => import('./features/tags/TagsPage'));
const TrashPage = lazy(() => import('./features/trash/TrashPage'));
const SettingsPage = lazy(() => import('./features/settings/SettingsPage'));
const WhatsNewPage = lazy(() => import('./features/settings/WhatsNewPage'));
const ProfilePage = lazy(() => import('./features/user/ProfilePage'));
const VaultPage = lazy(() => import('./features/vault/VaultPage'));
const SharedWithMePage = lazy(() => import('./features/sharing/SharedWithMePage'));
const GroupsPage = lazy(() => import('./features/groups/GroupsPage'));

// Public pages
const PublicNotePage = lazy(() => import('./features/public/PublicNotePage'));

// Auth pages
const LoginPage = lazy(() => import('./features/auth/LoginPage'));
const RegisterPage = lazy(() => import('./features/auth/RegisterPage'));
const ForgotPasswordPage = lazy(() => import('./features/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./features/auth/ResetPasswordPage'));
const VerifyEmailPage = lazy(() => import('./features/auth/VerifyEmailPage'));
const RequestInvitePage = lazy(() => import('./features/auth/RequestInvitePage'));

// Admin
const AdminPage = lazy(() => import('./features/admin/AdminPage'));

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
      <Suspense fallback={<PageLoader />}>
        <Routes>
          {/* Protected Routes inside AppLayout */}
          <Route element={<AppLayout />}>
            <Route index element={<Navigate to="/notes" replace />} />
            <Route path="notes" element={<NotesPage />} />
            <Route path="notebooks" element={<NotebooksPage />} />
            <Route path="reminders" element={<RemindersPage />} />
            <Route path="tasks" element={<TaskListsPage />} />
            <Route path="kanban" element={<KanbanPage />} />
            <Route path="tags" element={<TagsPage />} />
            <Route path="trash" element={<TrashPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="whats-new" element={<WhatsNewPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="vault" element={<VaultPage />} />
            <Route path="shared" element={<SharedWithMePage />} />
            <Route path="groups" element={<GroupsPage />} />
          </Route>

          {/* Public Routes */}
          <Route path="public/notes/:noteId" element={<PublicNotePage />} />

          {/* Auth Routes */}
          <Route path="login" element={<LoginPage />} />
          <Route path="register" element={<RegisterPage />} />
          <Route path="forgot-password" element={<ForgotPasswordPage />} />
          <Route path="reset-password" element={<ResetPasswordPage />} />
          <Route path="verify-email" element={<VerifyEmailPage />} />
          <Route path="request-invite" element={<RequestInvitePage />} />

          {/* Admin Route */}
          <Route path="admin" element={<AdminPage />} />

          {/* Catch all - redirect to notes or a 404 page */}
          <Route path="*" element={<Navigate to="/notes" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}

export default App;
