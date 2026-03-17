import { useState, useEffect, useRef } from 'react';
import { useAgentsStore } from '../../store/agents';
import { useSharedSpaceStore } from '../../store/sharedspace';
import styles from './CommandPalette.module.css';

interface CommandEntry {
  label: string;
  action: () => void;
}

interface CommandPaletteProps {
  onClose: () => void;
  onChatWith: (agentId: string) => void;
  onSetMode: (mode: 'queue' | 'sharedspace' | 'cost') => void;
}

export function CommandPalette({ onClose, onChatWith, onSetMode }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const agents = useAgentsStore((s) => s.agents);
  const pages = useSharedSpaceStore((s) => s.pages);

  // Build command list
  const commands: CommandEntry[] = [
    ...agents.map((a) => ({
      label: `Chat with ${a.agent_name}`,
      action: () => { onChatWith(a.agent_id); onClose(); },
    })),
    ...agents.map((a) => ({
      label: `Edit CLAUDE.md for ${a.agent_name}`,
      action: () => { onClose(); /* TODO: open modal */ },
    })),
    {
      label: 'View queue',
      action: () => { onSetMode('queue'); onClose(); },
    },
    {
      label: 'Open cost overview',
      action: () => { onSetMode('cost'); onClose(); },
    },
    ...pages.map((p) => ({
      label: `New SharedSpace page under /${p.page_id}`,
      action: () => { onSetMode('sharedspace'); onClose(); },
    })),
    ...agents.map((a) => ({
      label: `Add scheduled task for ${a.agent_name}`,
      action: () => { onClose(); /* TODO: open modal */ },
    })),
    ...agents.map((a) => ({
      label: `Delete agent ${a.agent_name}`,
      action: () => { onClose(); /* TODO: confirm dialog */ },
    })),
    ...agents.map((a) => ({
      label: `Reset daily budget for ${a.agent_name}`,
      action: () => { onClose(); /* TODO: call REST */ },
    })),
  ];

  // Fuzzy filter
  const lowerQuery = query.toLowerCase();
  const filtered = query
    ? commands.filter((c) => c.label.toLowerCase().includes(lowerQuery))
    : commands;

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((prev) => Math.min(prev + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const entry = filtered[activeIdx];
      if (entry) entry.action();
      return;
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.palette} onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command..."
        />
        <div className={styles.results}>
          {filtered.length === 0 && (
            <div className={styles.noResults}>No matching commands</div>
          )}
          {filtered.map((entry, i) => (
            <button
              key={entry.label}
              className={`${styles.resultItem} ${i === activeIdx ? styles.resultActive : ''}`}
              onClick={() => entry.action()}
              onMouseEnter={() => setActiveIdx(i)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
