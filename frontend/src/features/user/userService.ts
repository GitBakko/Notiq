const API_URL = import.meta.env.VITE_API_URL || '/api';

export const updateProfile = async (token: string, data: Record<string, unknown>) => {
  const response = await fetch(`${API_URL}/user/me`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error('Failed to update profile');
  }

  return response.json();
};

export const changePassword = async (token: string, data: Record<string, unknown>) => {
  const response = await fetch(`${API_URL}/user/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error('Failed to change password');
  }

  return response.json();
};

export const uploadAvatar = async (token: string, file: File) => {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_URL}/user/me/avatar`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error('Failed to upload avatar');
  }

  return response.json();
};
