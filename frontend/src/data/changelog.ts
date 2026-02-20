export interface ChangelogEntry {
  type: 'feature' | 'fix' | 'improvement';
  titleKey: string;
}

export interface VersionEntry {
  version: string;
  date: string;
  entries: ChangelogEntry[];
}

export const changelog: VersionEntry[] = [
  {
    version: '1.1.0',
    date: '2026-02-20',
    entries: [
      { type: 'feature', titleKey: 'whatsNew.entries.notificationSound' },
      { type: 'feature', titleKey: 'whatsNew.entries.pushNotifications' },
      { type: 'feature', titleKey: 'whatsNew.entries.listAutoFormat' },
      { type: 'feature', titleKey: 'whatsNew.entries.inlineImages' },
      { type: 'feature', titleKey: 'whatsNew.entries.pasteControl' },
      { type: 'feature', titleKey: 'whatsNew.entries.scrollToEdit' },
      { type: 'feature', titleKey: 'whatsNew.entries.whatsNew' },
      { type: 'feature', titleKey: 'whatsNew.entries.sorting' },
      { type: 'feature', titleKey: 'whatsNew.entries.vaultTags' },
      { type: 'feature', titleKey: 'whatsNew.entries.credentials' },
      { type: 'improvement', titleKey: 'whatsNew.entries.notebookPicker' },
      { type: 'improvement', titleKey: 'whatsNew.entries.projectCleanup' },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-02-19',
    entries: [
      { type: 'feature', titleKey: 'whatsNew.entries.initialRelease' },
    ],
  },
];

export const CURRENT_VERSION = changelog[0].version;
