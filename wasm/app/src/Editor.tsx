// ---------------------------------------------------------------------------
// G-code source editor overlay. Double-clicking a .nc/.gcode source opens this;
// Save writes the text back (and re-sims any sim using it), Close discards.
// ---------------------------------------------------------------------------

import { useState, useEffect, useRef } from 'preact/hooks';

interface Props {
  name: string;
  text: string;
  onSave: (text: string) => void;
  onClose: () => void;
}

export function Editor({ name, text, onSave, onClose }: Props) {
  const [value, setValue] = useState(text);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dirty = value !== text;

  useEffect(() => {
    taRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        onSave(value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [value, onSave, onClose]);

  const lines = value.split('\n').length;

  return (
    <div class="ed-backdrop" onPointerDown={onClose}>
      <div class="ed-pane" onPointerDown={(e) => e.stopPropagation()}>
        <div class="ed-head">
          <span class="ed-name">
            {name}
            {dirty ? ' •' : ''}
          </span>
          <span class="ed-meta">{lines} lines</span>
          <span class="ed-spacer" />
          <button class="btn" onClick={onClose}>
            Close
          </button>
          <button class="btn primary" disabled={!dirty} onClick={() => onSave(value)}>
            Save &amp; run
          </button>
        </div>
        <textarea
          ref={taRef}
          class="ed-text"
          spellcheck={false}
          value={value}
          onInput={(e) => setValue((e.currentTarget as HTMLTextAreaElement).value)}
        />
      </div>
    </div>
  );
}
