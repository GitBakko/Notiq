declare module 'react-speech-recognition' {
  export interface SpeechRecognitionOptions {
    transcribing?: boolean;
    clearTranscriptOnListen?: boolean;
    commands?: {
      command: string | string[] | RegExp;
      callback: (...args: any[]) => void;
      isFuzzyMatch?: boolean;
      matchInterim?: boolean;
      fuzzyMatchingThreshold?: number;
      bestMatchOnly?: boolean;
    }[];
  }

  export interface SpeechRecognition {
    getRecognition(): SpeechRecognition | null;
    startListening(options?: { continuous?: boolean; language?: string }): Promise<void>;
    stopListening(): Promise<void>;
    abortListening(): Promise<void>;
    browserSupportsSpeechRecognition(): boolean;
    applyPolyfill(speechRecognitionPolyfill: any): void;
  }

  export interface useSpeechRecognitionResponse {
    transcript: string;
    interimTranscript: string;
    finalTranscript: string;
    listening: boolean;
    resetTranscript: () => void;
    browserSupportsSpeechRecognition: boolean;
    isMicrophoneAvailable: boolean;
  }

  export function useSpeechRecognition(options?: SpeechRecognitionOptions): useSpeechRecognitionResponse;

  const SpeechRecognition: SpeechRecognition;
  export default SpeechRecognition;
}
