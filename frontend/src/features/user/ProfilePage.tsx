import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/authStore';
import { Button } from '../../components/ui/Button';
import { User, Save, ArrowLeft, Phone, Camera, KeyRound, Menu, Mail } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import SearchableSelect from '../../components/ui/SearchableSelect';
import DatePicker from '../../components/ui/DatePicker';
import Modal from '../../components/ui/Modal';
import toast from 'react-hot-toast';
import { FlagIcon } from '../../components/ui/FlagIcon';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';
import { Ticket } from 'lucide-react';
import api from '../../lib/api';

export default function ProfilePage() {
  const { t, i18n } = useTranslation();
  const { user, updateUser, changePassword, uploadAvatar } = useAuthStore();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();

  const [formData, setFormData] = useState({
    name: user?.name || '',
    surname: user?.surname || '',
    email: user?.email || '',
    gender: user?.gender || '',
    dateOfBirth: user?.dateOfBirth ? new Date(user.dateOfBirth).toISOString().split('T')[0] : '',
    placeOfBirth: user?.placeOfBirth || '',
    mobile: user?.mobile || '',
  });

  const [passwordData, setPasswordData] = useState({
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  const [isLoading, setIsLoading] = useState(false);
  const [isPasswordLoading, setIsPasswordLoading] = useState(false);
  const [isChangePasswordModalOpen, setIsChangePasswordModalOpen] = useState(false);

  // Send Invite State
  const [isSendInviteModalOpen, setIsSendInviteModalOpen] = useState(false);
  const [isSendingInvite, setIsSendingInvite] = useState(false);
  const [sendInviteData, setSendInviteData] = useState({ code: '', email: '', name: '' });

  const [invitationEnabled, setInvitationEnabled] = useState(false);
  const [invites, setInvites] = useState<{ id: string; code: string; status: string; email?: string; createdAt: string; usedBy?: { email: string; name: string; isVerified?: boolean } }[]>([]);

  const fetchInvites = async () => {
    try {
      const res = await api.get('/invites');
      setInvites(res.data);
    } catch {
      console.error('Failed to fetch invites');
    }
  };

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await api.get('/auth/config');
        setInvitationEnabled(res.data.invitationSystemEnabled);
        if (res.data.invitationSystemEnabled) {
          fetchInvites();
        }
      } catch (err) {
        console.error('Failed to load auth config', err);
      }
    };
    fetchConfig();
  }, []);

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      await updateUser(formData);
      toast.success(t('profile.updated'));
    } catch {
      toast.error(t('profile.updateFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordData.newPassword !== passwordData.confirmPassword) {
      toast.error(t('profile.passwordMismatch'));
      return;
    }
    setIsPasswordLoading(true);
    try {
      await changePassword(passwordData.oldPassword, passwordData.newPassword);
      toast.success(t('profile.passwordUpdated'));
      setPasswordData({ oldPassword: '', newPassword: '', confirmPassword: '' });
      setIsChangePasswordModalOpen(false);
    } catch {
      toast.error(t('profile.passwordUpdateFailed'));
    } finally {
      setIsPasswordLoading(false);
    }
  };

  const handleSendInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sendInviteData.email) return;

    setIsSendingInvite(true);
    try {
      await api.post(`/invites/${sendInviteData.code}/email`, { // Using new route
        email: sendInviteData.email,
        name: sendInviteData.name,
        locale: i18n.language // Pass current locale
      });
      toast.success(t('profile.inviteSent', 'Invitation sent successfully!'));
      setIsSendInviteModalOpen(false);
      setSendInviteData({ code: '', email: '', name: '' });
    } catch {
      toast.error(t('profile.inviteSendFailed', 'Failed to send invitation'));
    } finally {
      setIsSendingInvite(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      await uploadAvatar(file);
      toast.success(t('profile.avatarUpdated'));
    } catch {
      toast.error(t('profile.avatarUpdateFailed'));
    }
  };

  return (
    <div className="flex-1 h-full overflow-y-auto bg-gray-50 p-4 sm:p-8 dark:bg-gray-900">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-2 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors"
          >
            <ArrowLeft size={20} />
            <span>{t('common.back')}</span>
          </button>
          {isMobile && (
            <button onClick={toggleSidebar} className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200">
              <Menu size={24} />
            </button>
          )}
        </div>

        {/* Profile Header */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden dark:bg-gray-800 dark:border-gray-700">
          <div className="p-6 sm:p-8 flex items-center gap-6">
            <div className="relative group">
              <div className="h-24 w-24 rounded-full bg-emerald-600 flex items-center justify-center text-white text-3xl font-bold shadow-md overflow-hidden">
                {user?.avatarUrl ? (
                  <img src={user.avatarUrl} alt={t('common.profileAlt')} className="w-full h-full object-cover" />
                ) : (
                  formData.name?.[0]?.toUpperCase() || formData.email?.[0]?.toUpperCase() || 'U'
                )}
              </div>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="absolute bottom-0 right-0 p-2 bg-white dark:bg-gray-700 rounded-full shadow-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
              >
                <Camera size={16} className="text-gray-600 dark:text-gray-300" />
              </button>
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept="image/*"
                onChange={handleFileChange}
              />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('profile.title')}</h1>
              <p className="text-gray-500 dark:text-gray-400">{user?.email}</p>
            </div>
          </div>
        </div>

        <div className="space-y-8">
          {/* Personal Information */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden dark:bg-gray-800 dark:border-gray-700">
            <div className="p-6 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <User size={20} />
                {t('profile.personalInfo')}
              </h2>
            </div>
            <form onSubmit={handleProfileSubmit} className="p-6 space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('auth.name')}</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-emerald-500 focus:border-emerald-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('auth.surname')}</label>
                  <input
                    type="text"
                    value={formData.surname}
                    onChange={(e) => setFormData({ ...formData, surname: e.target.value })}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-emerald-500 focus:border-emerald-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('auth.email')}</label>
                  <input
                    type="email"
                    value={formData.email}
                    disabled
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm bg-gray-50 text-gray-500 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-400 cursor-not-allowed"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('auth.mobile')}</label>
                  <div className="relative">
                    <Phone size={16} className="absolute left-3 top-3 text-gray-400" />
                    <input
                      type="tel"
                      value={formData.mobile}
                      onChange={(e) => setFormData({ ...formData, mobile: e.target.value })}
                      className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-emerald-500 focus:border-emerald-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('auth.gender')}</label>
                  <SearchableSelect
                    options={[
                      { value: 'male', label: t('gender.male') },
                      { value: 'female', label: t('gender.female') },
                      { value: 'other', label: t('gender.other') },
                    ]}
                    value={formData.gender}
                    onChange={(val) => setFormData({ ...formData, gender: val })}
                    placeholder={t('common.select')}
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('auth.dateOfBirth')}</label>
                  <DatePicker
                    date={formData.dateOfBirth ? new Date(formData.dateOfBirth) : undefined}
                    onSelect={(date) => setFormData({ ...formData, dateOfBirth: date ? date.toISOString().split('T')[0] : '' })}
                    placeholder={t('auth.dateOfBirth')}
                    className="w-full"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('common.language')}</label>
                  <SearchableSelect
                    options={[
                      { value: 'it', label: 'Italiano', icon: <FlagIcon countryCode="it" /> },
                      { value: 'en', label: 'English', icon: <FlagIcon countryCode="en" /> },
                    ]}
                    value={i18n.language.split('-')[0]}
                    onChange={(val) => i18n.changeLanguage(val)}
                    placeholder={t('common.select')}
                  />
                </div>
              </div>

              <div className="pt-4 flex justify-between items-center">
                <Button
                  type="button"
                  variant="primary"
                  className="bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-500 dark:bg-indigo-600 dark:hover:bg-indigo-500"
                  onClick={() => setIsChangePasswordModalOpen(true)}
                >
                  <KeyRound size={18} className="mr-2" />
                  {t('profile.changePassword')}
                </Button>
                <Button type="submit" variant="primary" disabled={isLoading}>
                  <Save size={18} className="mr-2" />
                  {isLoading ? t('common.saving') : t('common.save')}
                </Button>
              </div>
            </form>
          </div>
        </div>
        {invitationEnabled && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden dark:bg-gray-800 dark:border-gray-700">
            <div className="p-6 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <Ticket size={20} />
                {t('profile.invitations')}
              </h2>
            </div>
            <div className="p-6 space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('profile.availableInvites')}: <span className="font-bold text-gray-900 dark:text-white">{user?.invitesAvailable}</span>
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {t('profile.shareInfo')}
                  </p>
                </div>
                <Button
                  onClick={async () => {
                    try {
                      await api.post('/invites');
                      toast.success(t('profile.inviteGenerated'));
                      fetchInvites();
                      // Refresh user to get updated invite count (not implemented yet, but good to have)
                      // window.location.reload(); // Too aggressive. 
                      // updateUser({...user, invitesAvailable: user.invitesAvailable - 1}); // Optimistic update if simple
                    } catch {
                      toast.error(t('profile.generateFailed'));
                    }
                  }}
                  disabled={!user?.invitesAvailable || user?.invitesAvailable <= 0}
                >
                  {t('profile.generateInvite')}
                </Button>
              </div>

              {/* List of Invites */}
              <div className="border rounded-md divide-y dark:border-gray-700 dark:divide-gray-700">
                {invites.length === 0 ? (
                  <div className="p-4 text-center text-sm text-gray-500 dark:text-gray-400">
                    {t('profile.noInvites')}
                  </div>
                ) : (
                  invites.map((invite) => (
                    <div key={invite.id} className="p-4 flex items-center justify-between">
                      <div>
                        <p className="font-mono font-bold text-lg text-gray-900 dark:text-white tracking-widest">{invite.code}</p>
                        <p className="text-xs text-gray-500">
                          {t('profile.created')}: {new Date(invite.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="text-right">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${invite.status === 'USED'
                          ? 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                          : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
                          }`}>
                          {invite.status}
                        </span>

                        {invite.status === 'PENDING' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="ml-2 text-xs h-6 px-2 text-emerald-600"
                            onClick={() => {
                              setSendInviteData({ code: invite.code, email: '', name: '' });
                              setIsSendInviteModalOpen(true);
                            }}
                          >
                            <Mail size={12} className="mr-1" /> {t('common.send', 'Send')}
                          </Button>
                        )}

                        {invite.usedBy && (
                          <div className="mt-1">
                            <p className="text-xs text-gray-500">{t('profile.usedBy')}: {invite.usedBy.email}</p>
                            {!invite.usedBy.isVerified && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-xs h-6 px-2 mt-1 text-indigo-600 hover:text-indigo-800 dark:text-indigo-400"
                                onClick={async () => {
                                  try {
                                    await api.post(`/invites/${invite.code}/resend`);
                                    toast.success(t('profile.verificationResent'));
                                  } catch {
                                    toast.error(t('profile.resendFailed'));
                                  }
                                }}
                              >
                                {t('profile.resendVerification')}
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <Modal
        isOpen={isChangePasswordModalOpen}
        onClose={() => setIsChangePasswordModalOpen(false)}
        title={t('profile.changePassword')}
      >
        <form onSubmit={handlePasswordSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('auth.currentPassword')}</label>
            <input
              type="password"
              value={passwordData.oldPassword}
              onChange={(e) => setPasswordData({ ...passwordData, oldPassword: e.target.value })}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-emerald-500 focus:border-emerald-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              required
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('auth.newPassword')}</label>
            <input
              type="password"
              value={passwordData.newPassword}
              onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-emerald-500 focus:border-emerald-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              required
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('auth.confirmPassword')}</label>
            <input
              type="password"
              value={passwordData.confirmPassword}
              onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-emerald-500 focus:border-emerald-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              required
            />
          </div>
          <div className="pt-4 flex justify-end gap-3">
            <Button type="button" variant="ghost" onClick={() => setIsChangePasswordModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={isPasswordLoading}>
              {isPasswordLoading ? t('common.saving') : t('profile.updatePassword')}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isSendInviteModalOpen}
        onClose={() => setIsSendInviteModalOpen(false)}
        title={t('profile.sendInvite', 'Send Invitation')}
      >
        <form onSubmit={handleSendInviteSubmit} className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('profile.sendInviteDesc', 'Enter the email address of the person you want to invite.')}
          </p>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('auth.email')}</label>
            <input
              type="email"
              value={sendInviteData.email}
              onChange={(e) => setSendInviteData({ ...sendInviteData, email: e.target.value })}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-emerald-500 focus:border-emerald-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              required
              placeholder={t('profile.invitePlaceholderEmail')}
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('auth.name')} ({t('common.optional', 'Optional')})</label>
            <input
              type="text"
              value={sendInviteData.name}
              onChange={(e) => setSendInviteData({ ...sendInviteData, name: e.target.value })}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-emerald-500 focus:border-emerald-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              placeholder={t('profile.invitePlaceholderName')}
            />
          </div>

          <div className="pt-4 flex justify-end gap-3">
            <Button type="button" variant="ghost" onClick={() => setIsSendInviteModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={isSendingInvite}>
              {isSendingInvite ? t('common.sending', 'Sending...') : t('common.send', 'Send')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
