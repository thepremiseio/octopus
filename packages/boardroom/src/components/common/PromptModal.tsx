import { useEffect, useRef, useState } from 'react';
import styles from './PromptModal.module.css';

export interface PromptField {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
}

interface PromptModalProps {
  title: string;
  fields?: PromptField[];
  /** If set, shows a confirmation dialog instead of input fields */
  confirmMessage?: string;
  /** Danger styling for destructive confirms */
  danger?: boolean;
  submitLabel?: string;
  cancelLabel?: string;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}

export function PromptModal({
  title,
  fields,
  confirmMessage,
  danger,
  submitLabel = 'OK',
  cancelLabel = 'Cancel',
  onSubmit,
  onCancel,
}: PromptModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields ?? []) {
      init[f.key] = f.defaultValue ?? '';
    }
    return init;
  });
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(values);
  }

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <form
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className={styles.title}>{title}</div>

        {confirmMessage && (
          <div className={`${styles.message} ${danger ? styles.messageDanger : ''}`}>
            {confirmMessage}
          </div>
        )}

        {fields?.map((f, i) => (
          <label key={f.key} className={styles.field}>
            <span className={styles.fieldLabel}>{f.label}</span>
            <input
              ref={i === 0 ? firstRef : undefined}
              className={styles.input}
              value={values[f.key] ?? ''}
              placeholder={f.placeholder}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.key]: e.target.value }))
              }
            />
          </label>
        ))}

        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="submit"
            className={danger ? styles.dangerBtn : styles.submitBtn}
            ref={!fields?.length ? (firstRef as React.RefObject<HTMLButtonElement>) : undefined}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
