import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Editor } from '@tiptap/react';

vi.mock('react-speech-recognition', () => ({
  default: { startListening: vi.fn(), stopListening: vi.fn() },
  useSpeechRecognition: () => ({
    transcript: '',
    listening: false,
    resetTranscript: vi.fn(),
    browserSupportsSpeechRecognition: false,
  }),
}));
vi.mock('../../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../../hooks/useVisualViewport', () => ({
  useVisualViewport: () => ({ isKeyboardOpen: false, keyboardHeight: 0 }),
}));
vi.mock('../toolbar/EditorToolbarPrimary', () => ({ default: () => null }));
vi.mock('../toolbar/EditorToolbarSecondary', () => ({
  default: (props: { isVault?: boolean }) => <div data-testid="secondary" data-vault={String(!!props.isVault)} />,
}));

import EditorToolbar from '../EditorToolbar';

const editorStub = {} as unknown as Editor;

afterEach(cleanup);

describe('EditorToolbar', () => {
  it('passes isVault to the secondary row', () => {
    render(<EditorToolbar editor={editorStub} isVault />);
    expect(screen.getByTestId('secondary').getAttribute('data-vault')).toBe('true');
  });

  it('reports isVault=false to the secondary row by default', () => {
    render(<EditorToolbar editor={editorStub} />);
    expect(screen.getByTestId('secondary').getAttribute('data-vault')).toBe('false');
  });
});
