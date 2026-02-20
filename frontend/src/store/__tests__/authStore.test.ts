import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAuthStore } from '../authStore';

// Mock the userService module so async store methods don't make real HTTP calls
vi.mock('../../features/user/userService', () => ({
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  changePassword: vi.fn(),
}));

const mockUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test',
  surname: 'User',
  role: 'USER' as const,
};

const mockToken = 'jwt-token-abc123';

describe('authStore', () => {
  beforeEach(() => {
    // Reset the store to its initial state before each test
    useAuthStore.setState({ user: null, token: null });
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('starts with null user and token', () => {
      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.token).toBeNull();
    });
  });

  describe('setAuth', () => {
    it('sets both user and token', () => {
      useAuthStore.getState().setAuth(mockUser, mockToken);

      const state = useAuthStore.getState();
      expect(state.user).toEqual(mockUser);
      expect(state.token).toBe(mockToken);
    });

    it('overwrites previous user and token', () => {
      useAuthStore.getState().setAuth(mockUser, mockToken);

      const newUser = { id: 'user-2', email: 'other@example.com' };
      const newToken = 'new-token';
      useAuthStore.getState().setAuth(newUser, newToken);

      const state = useAuthStore.getState();
      expect(state.user).toEqual(newUser);
      expect(state.token).toBe(newToken);
    });
  });

  describe('setToken', () => {
    it('updates only the token, leaving user unchanged', () => {
      useAuthStore.getState().setAuth(mockUser, mockToken);
      useAuthStore.getState().setToken('refreshed-token');

      const state = useAuthStore.getState();
      expect(state.token).toBe('refreshed-token');
      expect(state.user).toEqual(mockUser);
    });
  });

  describe('logout', () => {
    it('clears user and token', () => {
      useAuthStore.getState().setAuth(mockUser, mockToken);
      useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.token).toBeNull();
    });

    it('is idempotent when already logged out', () => {
      useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.token).toBeNull();
    });
  });

  describe('updateUser', () => {
    it('does nothing when not authenticated', async () => {
      // user and token are null
      await useAuthStore.getState().updateUser({ name: 'New Name' });

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
    });

    it('applies optimistic update immediately', async () => {
      const { updateProfile } = await import('../../features/user/userService');
      // Make the service call hang so we can inspect the optimistic state
      vi.mocked(updateProfile).mockImplementation(
        () => new Promise(() => {}) // never resolves
      );

      useAuthStore.getState().setAuth(mockUser, mockToken);
      // Fire and forget - don't await since it will never resolve
      const updatePromise = useAuthStore.getState().updateUser({ name: 'Optimistic' });

      // The store should reflect the optimistic update immediately
      const state = useAuthStore.getState();
      expect(state.user?.name).toBe('Optimistic');
      expect(state.user?.email).toBe(mockUser.email);

      // Cleanup: we won't await the promise since it never resolves
      void updatePromise;
    });

    it('applies server response after successful update', async () => {
      const { updateProfile } = await import('../../features/user/userService');
      const serverUser = { ...mockUser, name: 'Server Name', surname: 'Server Surname' };
      vi.mocked(updateProfile).mockResolvedValueOnce(serverUser);

      useAuthStore.getState().setAuth(mockUser, mockToken);
      await useAuthStore.getState().updateUser({ name: 'Server Name' });

      const state = useAuthStore.getState();
      expect(state.user).toEqual(serverUser);
    });

    it('logs error on update failure but does not crash', async () => {
      const { updateProfile } = await import('../../features/user/userService');
      vi.mocked(updateProfile).mockRejectedValueOnce(new Error('Network error'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      useAuthStore.getState().setAuth(mockUser, mockToken);
      await useAuthStore.getState().updateUser({ name: 'Will Fail' });

      expect(consoleSpy).toHaveBeenCalledWith('Update failed', expect.any(Error));
      consoleSpy.mockRestore();
    });
  });

  describe('uploadAvatar', () => {
    it('does nothing when not authenticated', async () => {
      const file = new File([''], 'avatar.png', { type: 'image/png' });
      await useAuthStore.getState().uploadAvatar(file);

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
    });

    it('updates user with server response on success', async () => {
      const { uploadAvatar } = await import('../../features/user/userService');
      const updatedUser = { ...mockUser, avatarUrl: '/uploads/avatar.png' };
      vi.mocked(uploadAvatar).mockResolvedValueOnce(updatedUser);

      useAuthStore.getState().setAuth(mockUser, mockToken);
      const file = new File(['image data'], 'avatar.png', { type: 'image/png' });
      await useAuthStore.getState().uploadAvatar(file);

      const state = useAuthStore.getState();
      expect(state.user?.avatarUrl).toBe('/uploads/avatar.png');
    });

    it('throws error on upload failure', async () => {
      const { uploadAvatar } = await import('../../features/user/userService');
      vi.mocked(uploadAvatar).mockRejectedValueOnce(new Error('Upload failed'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      useAuthStore.getState().setAuth(mockUser, mockToken);
      const file = new File([''], 'avatar.png', { type: 'image/png' });

      await expect(useAuthStore.getState().uploadAvatar(file)).rejects.toThrow('Upload failed');
      consoleSpy.mockRestore();
    });
  });

  describe('changePassword', () => {
    it('does nothing when not authenticated', async () => {
      const { changePassword } = await import('../../features/user/userService');
      await useAuthStore.getState().changePassword('old', 'new');
      expect(changePassword).not.toHaveBeenCalled();
    });

    it('calls the service with the correct arguments', async () => {
      const { changePassword } = await import('../../features/user/userService');
      vi.mocked(changePassword).mockResolvedValueOnce({});

      useAuthStore.getState().setAuth(mockUser, mockToken);
      await useAuthStore.getState().changePassword('oldPass', 'newPass');

      expect(changePassword).toHaveBeenCalledWith(mockToken, {
        oldPassword: 'oldPass',
        newPassword: 'newPass',
      });
    });
  });
});
