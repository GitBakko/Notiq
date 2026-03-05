import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { Settings, Sparkles, Eye, EyeOff } from 'lucide-react';
import api from '../../../lib/api';
import { Button } from '../../../components/ui/Button';

export default function SettingsTab() {
  const { t } = useTranslation();
  const [invitationEnabled, setInvitationEnabled] = useState(false);
  const [aiConfig, setAiConfig] = useState({
    enabled: false, provider: 'anthropic', apiKeySet: false,
    model: 'claude-sonnet-4-20250514', maxTokens: 4096, temperature: 0.7,
  });
  const [aiApiKey, setAiApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/auth/config'),
      api.get('/admin/ai-config').catch(() => ({ data: null })),
    ]).then(([configRes, aiRes]) => {
      setInvitationEnabled(configRes.data.invitationSystemEnabled);
      if (aiRes.data) setAiConfig(aiRes.data);
    });
  }, []);

  const saveSetting = async (key: string, value: string) => {
    try {
      await api.post('/admin/settings', { key, value });
    } catch { toast.error(t('admin.updateFailed')); }
  };

  const toggleInvitationSystem = async () => {
    await saveSetting('invitation_system_enabled', (!invitationEnabled).toString());
    setInvitationEnabled(!invitationEnabled);
    toast.success(t('admin.settingsUpdated'));
  };

  const handleAiToggle = async () => {
    const newVal = !aiConfig.enabled;
    setAiConfig(c => ({ ...c, enabled: newVal }));
    await saveSetting('ai_enabled', newVal.toString());
    toast.success(t('admin.settingsUpdated'));
  };

  const handleAiApiKeySave = async () => {
    if (!aiApiKey.trim()) return;
    await saveSetting('ai_api_key', aiApiKey.trim());
    setAiConfig(c => ({ ...c, apiKeySet: true }));
    setAiApiKey('');
    setShowApiKey(false);
    toast.success(t('admin.ai.saved'));
  };

  return (
    <div className="max-w-xl animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 dark:bg-neutral-800 dark:border-neutral-700/40">
        <h3 className="font-semibold mb-6 flex items-center gap-2 text-neutral-900 dark:text-white">
          <Settings size={20} /> {t('admin.settings', 'System Settings')}
        </h3>
        <div className="flex items-center justify-between pb-6 border-b border-neutral-100 dark:border-neutral-700/40">
          <div>
            <p className="font-medium text-neutral-900 dark:text-white">{t('admin.invitationSystem')}</p>
            <p className="text-xs text-neutral-500 mt-1">{t('admin.invitationSystemDesc')}</p>
          </div>
          <button
            onClick={toggleInvitationSystem}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${invitationEnabled ? 'bg-emerald-600' : 'bg-neutral-200 dark:bg-neutral-700'}`}
          >
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${invitationEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
      </div>

      {/* AI Configuration */}
      <div className="bg-white rounded-xl shadow-sm border border-neutral-100 p-6 dark:bg-neutral-800 dark:border-neutral-700/40 mt-6">
        <h3 className="font-semibold mb-6 flex items-center gap-2 text-neutral-900 dark:text-white">
          <Sparkles size={20} className="text-purple-500" /> {t('admin.ai.title')}
        </h3>

        <div className="flex items-center justify-between pb-4 border-b border-neutral-100 dark:border-neutral-700/40">
          <div>
            <p className="font-medium text-neutral-900 dark:text-white">{t('admin.ai.enabled')}</p>
            <p className="text-xs text-neutral-500 mt-1">{t('admin.ai.enabledDesc')}</p>
          </div>
          <button
            onClick={handleAiToggle}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${aiConfig.enabled ? 'bg-purple-600' : 'bg-neutral-200 dark:bg-neutral-700'}`}
          >
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${aiConfig.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        <div className="py-4 border-b border-neutral-100 dark:border-neutral-700/40">
          <label className="block text-sm font-medium text-neutral-900 dark:text-white mb-1">{t('admin.ai.apiKey')}</label>
          <p className={`text-xs mb-2 ${aiConfig.apiKeySet ? 'text-green-600' : 'text-red-500'}`}>
            {aiConfig.apiKeySet ? t('admin.ai.apiKeySet') : t('admin.ai.apiKeyNotSet')}
          </p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={aiApiKey}
                onChange={e => setAiApiKey(e.target.value)}
                placeholder={t('admin.ai.apiKeyPlaceholder')}
                className="w-full px-3 py-2 pr-10 text-sm border rounded-lg dark:bg-neutral-700 dark:text-white dark:border-neutral-600"
              />
              <button type="button" onClick={() => setShowApiKey(!showApiKey)} className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600">
                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <Button size="sm" onClick={handleAiApiKeySave} disabled={!aiApiKey.trim()}>
              {t('common.save')}
            </Button>
          </div>
        </div>

        <div className="py-4 border-b border-neutral-100 dark:border-neutral-700/40">
          <label className="block text-sm font-medium text-neutral-900 dark:text-white mb-1">{t('admin.ai.model')}</label>
          <select
            value={aiConfig.model}
            onChange={e => { setAiConfig(c => ({ ...c, model: e.target.value })); saveSetting('ai_model', e.target.value); }}
            className="w-full px-3 py-2 text-sm border rounded-lg dark:bg-neutral-700 dark:text-white dark:border-neutral-600"
          >
            <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
            <option value="claude-opus-4-20250514">Claude Opus 4</option>
            <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
          </select>
        </div>

        <div className="py-4 border-b border-neutral-100 dark:border-neutral-700/40">
          <label className="block text-sm font-medium text-neutral-900 dark:text-white mb-1">{t('admin.ai.maxTokens')}</label>
          <input
            type="number"
            value={aiConfig.maxTokens}
            onChange={e => {
              const v = Math.max(256, Math.min(8192, parseInt(e.target.value) || 4096));
              setAiConfig(c => ({ ...c, maxTokens: v }));
              saveSetting('ai_max_tokens', v.toString());
            }}
            min={256} max={8192} step={256}
            className="w-full px-3 py-2 text-sm border rounded-lg dark:bg-neutral-700 dark:text-white dark:border-neutral-600"
          />
        </div>

        <div className="pt-4">
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium text-neutral-900 dark:text-white">{t('admin.ai.temperature')}</label>
            <span className="text-sm text-neutral-500">{aiConfig.temperature.toFixed(1)}</span>
          </div>
          <input
            type="range"
            value={aiConfig.temperature}
            onChange={e => {
              const v = parseFloat(e.target.value);
              setAiConfig(c => ({ ...c, temperature: v }));
              saveSetting('ai_temperature', v.toString());
            }}
            min={0} max={1} step={0.1}
            className="w-full accent-purple-600"
          />
          <div className="flex justify-between text-xs text-neutral-400 mt-1">
            <span>Precise (0)</span>
            <span>Creative (1)</span>
          </div>
        </div>
      </div>
    </div>
  );
}
