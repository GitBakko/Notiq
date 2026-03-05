import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { Mail } from 'lucide-react';
import { format } from 'date-fns';
import api from '../../../lib/api';
import { Button } from '../../../components/ui/Button';

interface InvitationRequest {
  id: string;
  email: string;
  createdAt: string;
  status: string;
}

export default function RequestsTab() {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<InvitationRequest[]>([]);

  const fetchRequests = async () => {
    try {
      const res = await api.get('/admin/requests');
      setRequests(res.data);
    } catch {
      toast.error(t('admin.fetchFailed'));
    }
  };

  useEffect(() => { fetchRequests(); }, []);

  const handleAction = async (id: string, action: 'approve' | 'reject') => {
    try {
      await api.post(`/admin/requests/${id}/${action}`);
      toast.success(t(`admin.request${action === 'approve' ? 'Approved' : 'Rejected'}`, `Request ${action}d`));
      fetchRequests();
    } catch {
      toast.error(t('admin.updateFailed'));
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 dark:bg-neutral-800 dark:border-neutral-700/40">
        <h3 className="font-semibold mb-4 text-neutral-900 dark:text-white flex items-center gap-2">
          <Mail size={20} /> {t('admin.requests', 'Invitation Requests')}
        </h3>
        <div className="overflow-hidden">
          <table className="w-full text-sm text-left">
            <thead className="bg-neutral-50 text-neutral-500 uppercase font-medium dark:bg-neutral-900/50">
              <tr>
                <th className="px-6 py-3">{t('admin.users.user', 'Email')}</th>
                <th className="px-6 py-3">{t('admin.users.joined', 'Requested')}</th>
                <th className="px-6 py-3 text-right">{t('admin.users.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-700">
              {requests.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-6 py-4 text-center text-neutral-500">{t('admin.noRequests', 'No pending requests.')}</td>
                </tr>
              ) : requests.map((req) => (
                <tr key={req.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
                  <td className="px-6 py-4 font-medium text-neutral-900 dark:text-white">{req.email}</td>
                  <td className="px-6 py-4 text-neutral-500">{format(new Date(req.createdAt), 'PPpp')}</td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => handleAction(req.id, 'approve')}>
                        {t('admin.approve', 'Approve')}
                      </Button>
                      <Button size="sm" variant="secondary" className="text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => handleAction(req.id, 'reject')}>
                        {t('admin.reject', 'Reject')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
