import { useSharedSpaceStore } from '../../store/sharedspace';
import styles from './PageTree.module.css';

interface PageTreeProps {
  onSelectPage: (pageId: string) => void;
}

export function PageTree({ onSelectPage }: PageTreeProps) {
  const pages = useSharedSpaceStore((s) => s.pages);
  const currentPage = useSharedSpaceStore((s) => s.currentPage);
  const recentlyUpdated = useSharedSpaceStore((s) => s.recentlyUpdated);

  // Get the last segment of a page_id for display
  function shortLabel(pageId: string): string {
    const parts = pageId.split('/');
    return parts[parts.length - 1] ?? pageId;
  }

  return (
    <div className={styles.tree}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>Pages</span>
        <button className={styles.addButton} title="New page">+</button>
      </div>
      {pages.map((page) => {
        const isActive = currentPage?.page_id === page.page_id;
        const isRecent = recentlyUpdated.has(page.page_id);
        return (
          <div
            key={page.page_id}
            className={`${styles.pageRow} ${isActive ? styles.pageActive : ''}`}
            style={{ paddingLeft: 4 + page.depth * 16 }}
            onClick={() => onSelectPage(page.page_id)}
          >
            {isRecent && <span className={styles.recentDot}>&bull;</span>}
            <span className={styles.pageLabel}>{shortLabel(page.page_id)}</span>
            <span className={styles.pageOwner}>{page.owner_agent_id}</span>
          </div>
        );
      })}
    </div>
  );
}
