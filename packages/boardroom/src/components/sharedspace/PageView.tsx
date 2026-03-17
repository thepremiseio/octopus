import { useEffect, useState } from 'react';
import { marked } from 'marked';
import type { SharedSpacePageFull } from '../../types/api';
import { getSharedSpacePage, putSharedSpacePage, deleteSharedSpacePage } from '../../api/rest';
import { useSharedSpaceStore } from '../../store/sharedspace';
import { on } from '../../api/websocket';
import { formatTs } from '../../utils/format';
import styles from './PageView.module.css';

interface PageViewProps {
  pageId: string;
}

export function PageView({ pageId }: PageViewProps) {
  const [page, setPage] = useState<SharedSpacePageFull | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState('');
  const [banner, setBanner] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getSharedSpacePage(pageId).then((p) => {
      if (cancelled) return;
      setPage(p);
      useSharedSpaceStore.getState().setCurrentPage(p);
    });
    setBanner(null);
    setEditing(false);
    setConfirmDelete(false);
    return () => { cancelled = true; };
  }, [pageId]);

  // Listen for external updates
  useEffect(() => {
    const unsub = on('sharedspace.page.updated', (payload) => {
      if (payload.page_id !== pageId) return;
      if (payload.operation === 'deleted') {
        useSharedSpaceStore.getState().setCurrentPage(null);
        return;
      }
      if (payload.updated_by_agent_id !== 'ceo') {
        setBanner(`This page was updated by ${payload.updated_by_agent_id}`);
      }
    });
    return unsub;
  }, [pageId]);

  async function handleReload() {
    const p = await getSharedSpacePage(pageId);
    setPage(p);
    useSharedSpaceStore.getState().setCurrentPage(p);
    setBanner(null);
  }

  async function handleSave() {
    if (!page) return;
    const updated = await putSharedSpacePage(pageId, {
      title: page.title,
      summary: page.summary,
      owner_agent_id: page.owner_agent_id,
      body: editBody,
    });
    setPage(updated);
    useSharedSpaceStore.getState().setCurrentPage(updated);
    setEditing(false);
  }

  async function handleDelete() {
    await deleteSharedSpacePage(pageId);
    useSharedSpaceStore.getState().deletePage(pageId);
    useSharedSpaceStore.getState().setCurrentPage(null);
  }

  if (!page) {
    return <div className={styles.loading}>Loading...</div>;
  }

  const html = marked.parse(page.body, { async: false }) as string;

  return (
    <div className={styles.page}>
      <div className={styles.pagePath}>{page.page_id}</div>
      <div className={styles.meta}>
        {page.title} &middot; {page.owner_agent_id} &middot; {formatTs(page.updated_ts)}
      </div>

      {banner && (
        <div className={styles.banner}>
          <span>{banner}</span>
          <button className={styles.reloadBtn} onClick={() => void handleReload()}>
            Reload
          </button>
        </div>
      )}

      {editing ? (
        <>
          <textarea
            className={styles.editArea}
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
          />
          <div className={styles.editActions}>
            <button className={styles.saveBtn} onClick={() => void handleSave()}>
              Save
            </button>
            <button className={styles.cancelBtn} onClick={() => { setEditing(false); setEditBody(page.body); }}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div
            className={styles.body}
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <div className={styles.actions}>
            <button className={styles.editBtn} onClick={() => { setEditing(true); setEditBody(page.body); }}>
              edit
            </button>
            {confirmDelete ? (
              <>
                <button className={styles.deleteBtn} onClick={() => void handleDelete()}>
                  confirm delete
                </button>
                <button className={styles.cancelBtn} onClick={() => setConfirmDelete(false)}>
                  cancel
                </button>
              </>
            ) : (
              <button className={styles.deleteBtn} onClick={() => setConfirmDelete(true)}>
                delete
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
