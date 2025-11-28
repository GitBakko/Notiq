import { useState, useRef, useEffect } from 'react';
import { Mic, Square, Save, X, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

interface AudioRecorderProps {
  onSave: (blob: Blob) => void;
  onCancel: () => void;
}

export default function AudioRecorder({ onSave, onCancel }: AudioRecorderProps) {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current && isRecording) {
        mediaRecorderRef.current.stop();
      }
    };
  }, [isRecording]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setAudioBlob(blob);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setDuration(0);

      timerRef.current = setInterval(() => {
        setDuration(prev => prev + 1);
      }, 1000);

    } catch (err) {
      console.error('Error accessing microphone:', err);
      alert('Could not access microphone');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleSave = () => {
    if (audioBlob) {
      onSave(audioBlob);
    }
  };

  return (
    <div className="p-4 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 w-full max-w-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-900 dark:text-white">{t('editor.voiceMemo')}</h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
          <X size={20} />
        </button>
      </div>

      <div className="flex flex-col items-center gap-4">
        <div className="text-3xl font-mono font-bold text-gray-900 dark:text-white">
          {formatTime(duration)}
        </div>

        {!audioBlob ? (
          <div className="flex gap-4">
            {!isRecording ? (
              <button
                onClick={startRecording}
                className="rounded-full w-12 h-12 flex items-center justify-center bg-red-500 hover:bg-red-600 text-white p-0 transition-colors"
                title={t('editor.startRecording')}
              >
                <Mic size={24} />
              </button>
            ) : (
              <button
                onClick={stopRecording}
                className="rounded-full w-12 h-12 flex items-center justify-center bg-gray-800 hover:bg-gray-900 text-white p-0 animate-pulse transition-colors"
                title={t('editor.stopRecording')}
              >
                <Square size={24} />
              </button>
            )}
          </div>
        ) : (
          <div className="flex gap-2 w-full">
            <audio src={URL.createObjectURL(audioBlob)} controls className="w-full" />
          </div>
        )}

        {audioBlob && (
          <div className="flex gap-2 w-full mt-2">
            <button
              onClick={() => { setAudioBlob(null); setDuration(0); }}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-gray-100 hover:bg-gray-200 text-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-200 transition-colors"
            >
              <Trash2 size={16} />
              {t('common.discard')}
            </button>
            <button
              onClick={handleSave}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white transition-colors"
            >
              <Save size={16} />
              {t('common.save')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
