/**
 * Lightweight backend i18n for push notification localization.
 * Maps localizationKey → { en, it } with simple {{var}} interpolation.
 * Keys mirror frontend/src/locales/{en,it}.json → notifications.*
 */

type Locale = 'en' | 'it';

const translations: Record<string, Record<Locale, string>> = {
  // --- Share Note ---
  'notifications.shareNote': {
    en: '{{sharerName}} invited you to collaborate on note: {{itemName}}',
    it: '{{sharerName}} ti ha invitato a collaborare sulla nota: {{itemName}}',
  },
  'notifications.shareNote_TITLE': {
    en: 'Collaboration Invitation',
    it: 'Invito alla Collaborazione',
  },
  // --- Share Notebook ---
  'notifications.shareNotebook': {
    en: '{{sharerName}} invited you to collaborate on notebook: {{itemName}}',
    it: '{{sharerName}} ti ha invitato a collaborare sul taccuino: {{itemName}}',
  },
  'notifications.shareNotebook_TITLE': {
    en: 'Collaboration Invitation',
    it: 'Invito alla Collaborazione',
  },
  // --- Share Response ---
  'notifications.shareResponse': {
    en: '{{responderName}} {{action}} your invitation to {{itemName}}',
    it: '{{responderName}} ha {{action}} il tuo invito a {{itemName}}',
  },
  'notifications.shareResponse_TITLE': {
    en: 'Invitation Update',
    it: 'Aggiornamento Invito',
  },
  'notifications.shareResponseAccepted': {
    en: '{{responderName}} accepted your invitation to {{itemName}}',
    it: '{{responderName}} ha accettato il tuo invito per {{itemName}}',
  },
  'notifications.shareResponseAccepted_TITLE': {
    en: 'Invitation Accepted',
    it: 'Invito Accettato',
  },
  'notifications.shareResponseDeclined': {
    en: '{{responderName}} declined your invitation to {{itemName}}',
    it: '{{responderName}} ha rifiutato il tuo invito per {{itemName}}',
  },
  'notifications.shareResponseDeclined_TITLE': {
    en: 'Invitation Declined',
    it: 'Invito Rifiutato',
  },
  // --- Groups ---
  'notifications.groupInvite': {
    en: '{{ownerName}} added you to the group "{{groupName}}"',
    it: '{{ownerName}} ti ha aggiunto al gruppo "{{groupName}}"',
  },
  'notifications.groupInvite_TITLE': {
    en: 'Added to Group',
    it: 'Aggiunto al Gruppo',
  },
  'notifications.groupRemove': {
    en: '{{ownerName}} removed you from the group "{{groupName}}"',
    it: '{{ownerName}} ti ha rimosso dal gruppo "{{groupName}}"',
  },
  'notifications.groupRemove_TITLE': {
    en: 'Removed from Group',
    it: 'Rimosso dal Gruppo',
  },
  'notifications.groupMemberJoined': {
    en: '{{memberEmail}} has registered and joined your group "{{groupName}}"',
    it: '{{memberEmail}} si è registrato e si è unito al tuo gruppo "{{groupName}}"',
  },
  'notifications.groupMemberJoined_TITLE': {
    en: 'New Group Member',
    it: 'Nuovo Membro nel Gruppo',
  },
  // --- Task Items ---
  'notifications.taskItemAdded': {
    en: '{{userName}} added "{{itemText}}" to {{listTitle}}',
    it: '{{userName}} ha aggiunto "{{itemText}}" a {{listTitle}}',
  },
  'notifications.taskItemAdded_TITLE': {
    en: 'Item Added',
    it: 'Elemento Aggiunto',
  },
  'notifications.taskItemChecked': {
    en: '{{userName}} checked "{{itemText}}" in {{listTitle}}',
    it: '{{userName}} ha completato "{{itemText}}" in {{listTitle}}',
  },
  'notifications.taskItemChecked_TITLE': {
    en: 'Item Completed',
    it: 'Elemento Completato',
  },
  'notifications.taskItemUnchecked': {
    en: '{{userName}} unchecked "{{itemText}}" in {{listTitle}}',
    it: '{{userName}} ha deselezionato "{{itemText}}" in {{listTitle}}',
  },
  'notifications.taskItemUnchecked_TITLE': {
    en: 'Item Unchecked',
    it: 'Elemento Deselezionato',
  },
  'notifications.taskItemRemoved': {
    en: '{{userName}} removed "{{itemText}}" from {{listTitle}}',
    it: '{{userName}} ha rimosso "{{itemText}}" da {{listTitle}}',
  },
  'notifications.taskItemRemoved_TITLE': {
    en: 'Item Removed',
    it: 'Elemento Rimosso',
  },
  // --- Task List ---
  'notifications.taskListShared': {
    en: '{{sharerName}} shared the list "{{listTitle}}" with you',
    it: '{{sharerName}} ha condiviso la lista "{{listTitle}}" con te',
  },
  'notifications.taskListShared_TITLE': {
    en: 'Task List Shared',
    it: 'Task List Condivisa',
  },
  // --- Kanban ---
  'notifications.kanbanBoardShared': {
    en: '{{sharerName}} shared the board "{{itemName}}" with you',
    it: '{{sharerName}} ha condiviso la board "{{itemName}}" con te',
  },
  'notifications.kanbanBoardShared_TITLE': {
    en: 'Board Shared',
    it: 'Board Condivisa',
  },
  'notifications.kanbanCardAssigned': {
    en: '{{assignerName}} assigned you to "{{cardTitle}}" in board "{{boardTitle}}"',
    it: '{{assignerName}} ti ha assegnato a "{{cardTitle}}" nella board "{{boardTitle}}"',
  },
  'notifications.kanbanCardAssigned_TITLE': {
    en: 'Card Assigned',
    it: 'Card Assegnata',
  },
  'notifications.kanbanCommentAdded': {
    en: '{{authorName}} commented on "{{cardTitle}}" in board "{{boardTitle}}"',
    it: '{{authorName}} ha commentato "{{cardTitle}}" nella board "{{boardTitle}}"',
  },
  'notifications.kanbanCommentAdded_TITLE': {
    en: 'New Comment',
    it: 'Nuovo Commento',
  },
  'notifications.noteSharedViaKanban': {
    en: '{{sharerName}} shared note "{{noteTitle}}" with you via board "{{boardTitle}}"',
    it: '{{sharerName}} ha condiviso la nota "{{noteTitle}}" con te tramite la board "{{boardTitle}}"',
  },
  'notifications.noteSharedViaKanban_TITLE': {
    en: 'Note Shared via Board',
    it: 'Nota Condivisa tramite Board',
  },
  'notifications.kanbanCommentDeleted': {
    en: '{{authorName}} deleted a comment on "{{cardTitle}}" in board "{{boardTitle}}"',
    it: '{{authorName}} ha eliminato un commento su "{{cardTitle}}" nella board "{{boardTitle}}"',
  },
  'notifications.kanbanCommentDeleted_TITLE': {
    en: 'Comment Deleted',
    it: 'Commento Eliminato',
  },
  'notifications.kanbanCardMoved': {
    en: '{{actorName}} moved "{{cardTitle}}" from {{fromColumn}} to {{toColumn}}',
    it: '{{actorName}} ha spostato "{{cardTitle}}" da {{fromColumn}} a {{toColumn}}',
  },
  'notifications.kanbanCardMoved_TITLE': {
    en: 'Card Moved',
    it: 'Card Spostata',
  },
  // --- Chat ---
  'notifications.chatMessage': {
    en: '{{senderName}} sent you a message',
    it: '{{senderName}} ti ha inviato un messaggio',
  },
  'notifications.chatMessage_TITLE': {
    en: 'New Message',
    it: 'Nuovo Messaggio',
  },
  // --- Kanban Board Chat ---
  'notifications.kanbanBoardChat': {
    en: '{{senderName}} sent a message in board "{{boardTitle}}"',
    it: '{{senderName}} ha inviato un messaggio nella board "{{boardTitle}}"',
  },
  'notifications.kanbanBoardChat_TITLE': {
    en: 'Board Chat',
    it: 'Chat Board',
  },
  // --- UI labels ---
  'notifications.openApp': {
    en: 'Open App',
    it: 'Apri App',
  },
};

function interpolate(template: string, args: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => args[key] ?? `{{${key}}}`);
}

function normalizeLocale(locale: string | null | undefined): Locale {
  if (locale && (locale === 'it' || locale.startsWith('it'))) return 'it';
  return 'en';
}

export function resolveNotification(
  localizationKey: string | undefined,
  localizationArgs: Record<string, string> | undefined,
  locale: string | null | undefined,
  fallbackTitle: string,
  fallbackBody: string
): { title: string; body: string } {
  if (!localizationKey) return { title: fallbackTitle, body: fallbackBody };

  const lang = normalizeLocale(locale);
  const bodyEntry = translations[localizationKey];
  const titleEntry = translations[`${localizationKey}_TITLE`];

  if (!bodyEntry) return { title: fallbackTitle, body: fallbackBody };

  const body = localizationArgs
    ? interpolate(bodyEntry[lang], localizationArgs)
    : bodyEntry[lang];

  const title = titleEntry ? titleEntry[lang] : fallbackTitle;

  return { title, body };
}

export function resolveActionLabel(locale: string | null | undefined): string {
  const lang = normalizeLocale(locale);
  return translations['notifications.openApp']?.[lang] ?? 'Open App';
}
