import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export const remoteEditTrackerKey = new PluginKey('remoteEditTracker');

export interface RemoteEditInfo {
  pos: number;
  timestamp: number;
}

export const RemoteEditTracker = Extension.create({
  name: 'remoteEditTracker',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: remoteEditTrackerKey,
        state: {
          init(): RemoteEditInfo | null {
            return null;
          },
          apply(tr, prev): RemoteEditInfo | null {
            const ySyncMeta = tr.getMeta('y-sync$');
            if (!ySyncMeta || ySyncMeta.isChangeOrigin) return prev;

            let latestPos: number | null = null;
            tr.steps.forEach((step: any) => {
              const map = step.getMap();
              map.forEach((_oldStart: number, _oldEnd: number, newStart: number, newEnd: number) => {
                if (newEnd > newStart) latestPos = newEnd;
              });
            });

            if (latestPos !== null) {
              return { pos: Math.min(latestPos, tr.doc.content.size - 1), timestamp: Date.now() };
            }
            return prev;
          },
        },
      }),
    ];
  },
});
