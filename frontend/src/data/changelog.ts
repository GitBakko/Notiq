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
    version: '1.7.1',
    date: '2026-02-28',
    entries: [
      { type: 'improvement', titleKey: 'whatsNew.entries.visualRedesign' },
      { type: 'improvement', titleKey: 'whatsNew.entries.geistFont' },
      { type: 'improvement', titleKey: 'whatsNew.entries.slateDarkMode' },
      { type: 'fix', titleKey: 'whatsNew.entries.pushNotificationFix' },
      { type: 'fix', titleKey: 'whatsNew.entries.settingsToggleFix' },
      { type: 'fix', titleKey: 'whatsNew.entries.sharingPersistenceFix' },
    ],
  },
  {
    version: '1.7.0',
    date: '2026-02-27',
    entries: [
      { type: 'feature', titleKey: 'whatsNew.entries.kanbanOfflineSync' },
      { type: 'feature', titleKey: 'whatsNew.entries.kanbanGroupSharing' },
      { type: 'feature', titleKey: 'whatsNew.entries.vaultPBKDF2' },
      { type: 'feature', titleKey: 'whatsNew.entries.backendUnitTests' },
      { type: 'improvement', titleKey: 'whatsNew.entries.backendTypeSafety' },
      { type: 'improvement', titleKey: 'whatsNew.entries.perRouteRateLimiting' },
      { type: 'improvement', titleKey: 'whatsNew.entries.frontendLintCleanup' },
      { type: 'improvement', titleKey: 'whatsNew.entries.dbIndexes' },
      { type: 'fix', titleKey: 'whatsNew.entries.kanbanColumnI18n' },
      { type: 'fix', titleKey: 'whatsNew.entries.avatarPropagation' },
      { type: 'improvement', titleKey: 'whatsNew.entries.kanbanCardDetailUX' },
      { type: 'improvement', titleKey: 'whatsNew.entries.priorityIcons' },
    ],
  },
  {
    version: '1.6.9',
    date: '2026-02-27',
    entries: [
      { type: 'feature', titleKey: 'whatsNew.entries.kanbanPriority' },
      { type: 'feature', titleKey: 'whatsNew.entries.kanbanCommentNotifications' },
      { type: 'feature', titleKey: 'whatsNew.entries.kanbanMoveNotifications' },
      { type: 'feature', titleKey: 'whatsNew.entries.emailNotificationPreference' },
      { type: 'fix', titleKey: 'whatsNew.entries.italianTimeAgoFix' },
      { type: 'fix', titleKey: 'whatsNew.entries.kanbanCommentCountFix' },
    ],
  },
  {
    version: '1.6.8',
    date: '2026-02-27',
    entries: [
      { type: 'feature', titleKey: 'whatsNew.entries.sidebarCollapse' },
      { type: 'feature', titleKey: 'whatsNew.entries.collapseAll' },
      { type: 'feature', titleKey: 'whatsNew.entries.responsiveToolbar' },
      { type: 'fix', titleKey: 'whatsNew.entries.editorOverflowFix' },
      { type: 'fix', titleKey: 'whatsNew.entries.lineHeightValidation' },
      { type: 'improvement', titleKey: 'whatsNew.entries.mobileCloseButton' },
      { type: 'improvement', titleKey: 'whatsNew.entries.settingsImportAlignment' },
    ],
  },
  {
    version: '1.6.7',
    date: '2026-02-26',
    entries: [
      { type: 'feature', titleKey: 'whatsNew.entries.sharingIndicators' },
      { type: 'feature', titleKey: 'whatsNew.entries.sharedUsersModal' },
      { type: 'feature', titleKey: 'whatsNew.entries.groupMemberVisibility' },
      { type: 'improvement', titleKey: 'whatsNew.entries.sidebarStyleAlignment' },
    ],
  },
  {
    version: '1.6.6',
    date: '2026-02-26',
    entries: [
      { type: 'feature', titleKey: 'whatsNew.entries.kanbanColumnDnD' },
      { type: 'feature', titleKey: 'whatsNew.entries.taskListToKanbanModal' },
      { type: 'feature', titleKey: 'whatsNew.entries.notebookRenameSidebar' },
      { type: 'feature', titleKey: 'whatsNew.entries.collapsibleNoteList' },
      { type: 'fix', titleKey: 'whatsNew.entries.notebookMoveFix' },
      { type: 'improvement', titleKey: 'whatsNew.entries.removedHomeItem' },
    ],
  },
  {
    version: '1.6.5',
    date: '2026-02-26',
    entries: [
      { type: 'fix', titleKey: 'whatsNew.entries.sharingEmailFix' },
      { type: 'feature', titleKey: 'whatsNew.entries.sentInvitationsPanel' },
      { type: 'feature', titleKey: 'whatsNew.entries.smartMerge' },
    ],
  },
  {
    version: '1.6.4',
    date: '2026-02-25',
    entries: [
      { type: 'fix', titleKey: 'whatsNew.entries.conversionNavigation' },
      { type: 'fix', titleKey: 'whatsNew.entries.notebookSelectorDisabled' },
      { type: 'fix', titleKey: 'whatsNew.entries.taskListDeleteError' },
      { type: 'improvement', titleKey: 'whatsNew.entries.kanbanReminderAutoComplete' },
      { type: 'improvement', titleKey: 'whatsNew.entries.taskReminderAutoComplete' },
    ],
  },
  {
    version: '1.6.3',
    date: '2026-02-25',
    entries: [
      { type: 'improvement', titleKey: 'whatsNew.entries.taskListKeepOrRemove' },
      { type: 'improvement', titleKey: 'whatsNew.entries.notificationSmartLinks' },
    ],
  },
  {
    version: '1.6.2',
    date: '2026-02-25',
    entries: [
      { type: 'improvement', titleKey: 'whatsNew.entries.autoNavigateKanban' },
      { type: 'improvement', titleKey: 'whatsNew.entries.autoNavigateTasks' },
    ],
  },
  {
    version: '1.6.1',
    date: '2026-02-25',
    entries: [
      { type: 'feature', titleKey: 'whatsNew.entries.boardNoteLink' },
      { type: 'feature', titleKey: 'whatsNew.entries.boardAvatar' },
      { type: 'fix', titleKey: 'whatsNew.entries.groupSharingMembers' },
    ],
  },
  {
    version: '1.5.0',
    date: '2026-02-24',
    entries: [
      { type: 'feature', titleKey: 'whatsNew.entries.onenoteImport' },
      { type: 'feature', titleKey: 'whatsNew.entries.kanbanFilters' },
      { type: 'feature', titleKey: 'whatsNew.entries.ganttExport' },
      { type: 'feature', titleKey: 'whatsNew.entries.kanbanReminders' },
      { type: 'fix', titleKey: 'whatsNew.entries.kanbanHooksFix' },
      { type: 'fix', titleKey: 'whatsNew.entries.kanbanLocaleFix' },
    ],
  },
  {
    version: '1.4.0',
    date: '2026-02-23',
    entries: [
      { type: 'feature', titleKey: 'whatsNew.entries.kanbanBoards' },
      { type: 'feature', titleKey: 'whatsNew.entries.kanbanCoverImages' },
      { type: 'feature', titleKey: 'whatsNew.entries.kanbanPresence' },
      { type: 'feature', titleKey: 'whatsNew.entries.kanbanChat' },
      { type: 'feature', titleKey: 'whatsNew.entries.kanbanSharing' },
      { type: 'improvement', titleKey: 'whatsNew.entries.notificationLinks' },
      { type: 'improvement', titleKey: 'whatsNew.entries.chatTieredNotifications' },
    ],
  },
  {
    version: '1.3.0',
    date: '2026-02-23',
    entries: [
      { type: 'feature', titleKey: 'whatsNew.entries.taskLists' },
      { type: 'feature', titleKey: 'whatsNew.entries.taskListSharing' },
      { type: 'feature', titleKey: 'whatsNew.entries.taskListNotifications' },
      { type: 'feature', titleKey: 'whatsNew.entries.taskListDragDrop' },
      { type: 'improvement', titleKey: 'whatsNew.entries.remindersRename' },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-02-22',
    entries: [
      { type: 'feature', titleKey: 'whatsNew.entries.editorStatusBar' },
      { type: 'feature', titleKey: 'whatsNew.entries.notebookPickerNewNote' },
      { type: 'fix', titleKey: 'whatsNew.entries.vaultPermanentDelete' },
      { type: 'fix', titleKey: 'whatsNew.entries.attachmentRaceCondition' },
      { type: 'improvement', titleKey: 'whatsNew.entries.lineHeightRefinement' },
    ],
  },
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

// Read version from package.json (single source of truth)
import packageJson from '../../package.json';
export const CURRENT_VERSION = packageJson.version;
