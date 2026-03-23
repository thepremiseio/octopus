import { useEffect, useState } from 'react';
import { marked } from 'marked';
import type { SharedSpacePageFull } from '../../types/api';
import { getSharedSpacePage } from '../../api/rest';
import { useSharedSpaceStore } from '../../store/sharedspace';
import { on } from '../../api/websocket';
import styles from './PageView.module.css';

interface PageViewProps {
  pageId: string;
}

export function PageView({ pageId }: PageViewProps) {
  const [page, setPage] = useState<SharedSpacePageFull | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getSharedSpacePage(pageId).then((p) => {
      if (cancelled) return;
      setPage(p);
      useSharedSpaceStore.getState().setCurrentPage(p);
    });
    setBanner(null);
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
      setBanner(`This page was updated by ${payload.updated_by_agent_id}`);
    });
    return unsub;
  }, [pageId]);

  async function handleReload() {
    const p = await getSharedSpacePage(pageId);
    setPage(p);
    useSharedSpaceStore.getState().setCurrentPage(p);
    setBanner(null);
  }

  if (!page) {
    return <div className={styles.loading}>Loading...</div>;
  }

  const html = marked.parse(page.body, { async: false }) as string;
  const accessLabel = Array.isArray(page.access)
    ? page.access.join(', ')
    : page.access;

  return (
    <div className={styles.page}>
      <div className={styles.pagePath}>{page.page_id}</div>
      <div className={styles.meta}>
        <span className={styles.metaTitle}>{page.title}</span>
        {page.summary && (
          <span className={styles.metaSummary}>{page.summary}</span>
        )}
        <span className={styles.metaDetail}>
          owner: {page.owner} &middot; access: {accessLabel} &middot; {page.updated}
        </span>
      </div>

      {banner && (
        <div className={styles.banner}>
          <span>{banner}</span>
          <button className={styles.reloadBtn} onClick={() => void handleReload()}>
            Reload
          </button>
        </div>
      )}

      <div
        className={styles.body}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
