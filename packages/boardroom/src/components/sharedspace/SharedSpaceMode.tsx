import { useEffect } from 'react';
import { useSharedSpaceStore } from '../../store/sharedspace';
import { getSharedSpaceIndex } from '../../api/rest';
import { PageView } from './PageView';
import styles from './SharedSpaceMode.module.css';

export function SharedSpaceMode() {
  const currentPage = useSharedSpaceStore((s) => s.currentPage);

  useEffect(() => {
    void getSharedSpaceIndex().then((r) => {
      useSharedSpaceStore.getState().seedPageIndex(r.pages);
    });
  }, []);

  if (!currentPage) {
    return (
      <div className={styles.mode}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>SharedSpace</span>
        </div>
        <div className={styles.empty}>Select a page from the tree</div>
      </div>
    );
  }

  return (
    <div className={styles.mode}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>SharedSpace</span>
      </div>
      <div className={styles.body}>
        <PageView pageId={currentPage.page_id} />
      </div>
    </div>
  );
}
