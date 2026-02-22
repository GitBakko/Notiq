import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useRef, useCallback } from 'react';

export function ResizableImage({ node, updateAttributes, selected }: NodeViewProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startX.current = e.clientX;
    startWidth.current = imgRef.current?.offsetWidth || 300;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const diff = moveEvent.clientX - startX.current;
      const newWidth = Math.max(50, startWidth.current + diff);
      if (imgRef.current) {
        imgRef.current.style.width = `${newWidth}px`;
      }
    };

    const onMouseUp = (upEvent: MouseEvent) => {
      const diff = upEvent.clientX - startX.current;
      const newWidth = Math.max(50, startWidth.current + diff);
      updateAttributes({ width: `${newWidth}px` });
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [updateAttributes]);

  return (
    <NodeViewWrapper className="image-resizable" data-drag-handle style={{ display: 'inline-block' }}>
      <div className="relative inline-block" style={{ width: node.attrs.width || 'auto' }}>
        <img
          ref={imgRef}
          src={node.attrs.src}
          alt={node.attrs.alt || ''}
          title={node.attrs.title || ''}
          style={{ width: node.attrs.width || 'auto', maxWidth: '100%', height: 'auto' }}
          className={`block rounded-lg ${selected ? 'ring-2 ring-emerald-500' : ''}`}
          draggable={false}
        />
        {selected && (
          <div
            className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 rounded-tl cursor-se-resize border border-white dark:border-gray-900 shadow-sm"
            onMouseDown={onMouseDown}
            title="Drag to resize"
          />
        )}
      </div>
    </NodeViewWrapper>
  );
}
