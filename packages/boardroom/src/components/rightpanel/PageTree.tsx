import { useSharedSpaceStore } from '../../store/sharedspace';
import { useAgentsStore } from '../../store/agents';
import styles from './PageTree.module.css';

interface PageTreeProps {
  onSelectPage: (pageId: string) => void;
}

export function PageTree({ onSelectPage }: PageTreeProps) {
  const pages = useSharedSpaceStore((s) => s.pages);
  const currentPage = useSharedSpaceStore((s) => s.currentPage);
  const recentlyUpdated = useSharedSpaceStore((s) => s.recentlyUpdated);
  const agents = useAgentsStore((s) => s.agents);

  function ownerName(agentId: string): string {
    if (agentId === 'ceo') return 'CEO';
    const agent = agents.find((a) => a.agent_id === agentId);
    return agent?.agent_name ?? agentId;
  }

  // Build folder structure: track which folders we've already rendered
  const renderedFolders = new Set<string>();

  return (
    <div className={styles.tree}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>Pages</span>
      </div>
      {pages.map((page) => {
        const parts = page.page_id.split('/');
        const depth = parts.length - 1;
        const leafName = parts[parts.length - 1] ?? page.page_id;
        const isActive = currentPage?.page_id === page.page_id;
        const isRecent = recentlyUpdated.has(page.page_id);

        // Render any ancestor folders that haven't been rendered yet
        const folderHeaders: { name: string; depth: number }[] = [];
        for (let i = 0; i < depth; i++) {
          const folderPath = parts.slice(0, i + 1).join('/');
          if (!renderedFolders.has(folderPath)) {
            renderedFolders.add(folderPath);
            folderHeaders.push({ name: parts[i]!, depth: i });
          }
        }

        return (
          <div key={page.page_id}>
            {folderHeaders.map((f) => (
              <div
                key={f.name + f.depth}
                className={styles.folderRow}
                style={{ paddingLeft: 4 + f.depth * 14 }}
              >
                <span className={styles.folderIcon}>&#9662;</span>
                <span className={styles.folderLabel}>{f.name}</span>
              </div>
            ))}
            <div
              className={`${styles.pageRow} ${isActive ? styles.pageActive : ''}`}
              style={{ paddingLeft: 4 + depth * 14 }}
              onClick={() => onSelectPage(page.page_id)}
            >
              <span className={styles.pageLabel}>{leafName}</span>
              <span className={styles.pageOwner}>{ownerName(page.owner)}</span>
              {isRecent && <span className={styles.recentDot}>&bull;</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
