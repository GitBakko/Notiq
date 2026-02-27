import { useState, useEffect } from 'react';

interface VisualViewportState {
  /** True when virtual keyboard is likely open (viewport height decreased significantly) */
  isKeyboardOpen: boolean;
  /** Height of the keyboard in pixels (0 when closed) */
  keyboardHeight: number;
}

/**
 * Detects virtual keyboard open/close via window.visualViewport API.
 * Falls back to { isKeyboardOpen: false, keyboardHeight: 0 } when unsupported.
 */
export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>({
    isKeyboardOpen: false,
    keyboardHeight: 0,
  });

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const fullHeight = window.innerHeight;

    function handleResize() {
      if (!vv) return;
      const currentHeight = vv.height;
      const diff = fullHeight - currentHeight;
      // Consider keyboard open if viewport shrunk by more than 150px
      const isOpen = diff > 150;
      setState({
        isKeyboardOpen: isOpen,
        keyboardHeight: isOpen ? diff : 0,
      });
    }

    vv.addEventListener('resize', handleResize);
    return () => vv.removeEventListener('resize', handleResize);
  }, []);

  return state;
}
