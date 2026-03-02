import { useState, useCallback } from 'react';

/**
 * Manages all modal/sheet/overlay boolean states for KanbanBoardPage.
 * Consolidates ~12 boolean states and their toggle/set methods into a single hook.
 */
export function useBoardModals() {
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isNoteLinkPickerOpen, setIsNoteLinkPickerOpen] = useState(false);
  const [isBoardSharingGapOpen, setIsBoardSharingGapOpen] = useState(false);
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [isTaskListPickerOpen, setIsTaskListPickerOpen] = useState(false);
  const [showBoardMenu, setShowBoardMenu] = useState(false);
  const [showDeleteBoardConfirm, setShowDeleteBoardConfirm] = useState(false);

  // Clear unread when chat opens
  const handleChatToggle = useCallback(() => {
    setIsChatOpen((prev) => {
      if (!prev) setUnreadCount(0);
      return !prev;
    });
  }, []);

  const incrementUnread = useCallback(() => {
    setUnreadCount((prev) => prev + 1);
  }, []);

  return {
    // Share modal
    isShareOpen,
    setIsShareOpen,

    // Chat sidebar
    isChatOpen,
    setIsChatOpen,
    unreadCount,
    handleChatToggle,
    incrementUnread,

    // Note link picker
    isNoteLinkPickerOpen,
    setIsNoteLinkPickerOpen,

    // Board sharing gap modal
    isBoardSharingGapOpen,
    setIsBoardSharingGapOpen,

    // Archive modal
    isArchiveOpen,
    setIsArchiveOpen,

    // Task list picker
    isTaskListPickerOpen,
    setIsTaskListPickerOpen,

    // Board three-dot menu
    showBoardMenu,
    setShowBoardMenu,

    // Delete board confirm
    showDeleteBoardConfirm,
    setShowDeleteBoardConfirm,
  };
}
