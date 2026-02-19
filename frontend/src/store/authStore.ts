import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import * as userService from '../features/user/userService';

interface User {
  id: string;
  email: string;
  name?: string;
  surname?: string;
  gender?: string;
  dateOfBirth?: string;
  placeOfBirth?: string;
  mobile?: string;
  avatarUrl?: string;
  color?: string;
  role?: 'USER' | 'SUPERADMIN';
  invitesAvailable?: number;
}

interface AuthState {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  setToken: (token: string) => void;
  updateUser: (updates: Partial<User>) => Promise<void>;
  uploadAvatar: (file: File) => Promise<void>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      setAuth: (user, token) => set({ user, token }),
      setToken: (token) => set({ token }),
      updateUser: async (updates) => {
        const { token, user } = get();
        if (!token || !user) return;

        // Optimistic update
        set({ user: { ...user, ...updates } });

        try {
          const updatedUser = await userService.updateProfile(token, updates);
          set({ user: updatedUser });
        } catch (error) {
          // Revert on failure (simplified)
          console.error('Update failed', error);
        }
      },
      uploadAvatar: async (file) => {
        const { token, user } = get();
        if (!token || !user) return;

        try {
          const updatedUser = await userService.uploadAvatar(token, file);
          set({ user: updatedUser });
        } catch (error) {
          console.error('Avatar upload failed', error);
          throw error;
        }
      },
      changePassword: async (oldPassword, newPassword) => {
        const { token } = get();
        if (!token) return;
        await userService.changePassword(token, { oldPassword, newPassword });
      },
      logout: () => set({ user: null, token: null }),
    }),
    {
      name: 'auth-storage',
    }
  )
);
