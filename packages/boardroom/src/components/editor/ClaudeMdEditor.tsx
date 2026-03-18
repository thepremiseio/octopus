import { useEffect, useState } from 'react';
import { getClaudeMd, putClaudeMd } from '../../api/rest';
import { useAgentsStore } from '../../store/agents';
import styles from './ClaudeMdEditor.module.css';

interface ClaudeMdEditorProps {
  agentId: string;
  onClose: () => void;
}

export function ClaudeMdEditor({ agentId, onClose }: ClaudeMdEditorProps) {
  const [original, setOriginal] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const agents = useAgentsStore((s) => s.agents);
  const agent = agents.find((a) => a.agent_id === agentId);
  const agentName = agent?.agent_name ?? agentId;

  const dirty = content !== original;

  useEffect(() => {
    setLoading(true);
    void getClaudeMd(agentId).then((r) => {
      setOriginal(r.content);
      setContent(r.content);
      setLoading(false);
    });
  }, [agentId]);

  async function handleSave() {
    setSaving(true);
    await putClaudeMd(agentId, { content });
    setOriginal(content);
    setSaving(false);
  }

  function handleDiscard() {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  }

  if (loading) {
    return <div className={styles.loading}>Loading CLAUDE.md...</div>;
  }

  return (
    <div className={styles.editor}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.fileName}>CLAUDE.md</span>
          <span className={styles.agentLabel}>{agentName}</span>
          {dirty && <span className={styles.dirtyDot}>modified</span>}
        </div>
        <div className={styles.headerRight}>
          <button
            className={styles.saveBtn}
            disabled={!dirty || saving}
            onClick={() => void handleSave()}
          >
            {saving ? 'saving...' : 'save'}
          </button>
          <button className={styles.discardBtn} onClick={handleDiscard}>
            {dirty ? 'discard' : 'close'}
          </button>
        </div>
      </div>
      <textarea
        className={styles.textarea}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}
