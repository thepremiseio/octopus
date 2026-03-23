import { useState } from 'react';
import { useSharedSpaceStore } from '../../store/sharedspace';
import { useAgentsStore } from '../../store/agents';
import { putSharedSpacePage } from '../../api/rest';
import { PromptModal } from '../common/PromptModal';
import styles from './PageTree.module.css';

interface PageTreeProps {
  onSelectPage: (pageId: string) => void;
}

export function PageTree({ onSelectPage }: PageTreeProps) {
  const pages = useSharedSpaceStore((s) => s.pages);
  const currentPage = useSharedSpaceStore((s) => s.currentPage);
  const recentlyUpdated = useSharedSpaceStore((s) => s.recentlyUpdated);
  const [showCreate, setShowCreate] = useState(false);

  // Get the last segment of a page_id for display
  function shortLabel(pageId: string): string {
    const parts = pageId.split('/');
    return parts[parts.length - 1] ?? pageId;
  }

  const agents = useAgentsStore((s) => s.agents);

  function ownerName(agentId: string): string {
    if (agentId === 'ceo') return 'CEO';
    const agent = agents.find((a) => a.agent_id === agentId);
    return agent?.agent_name ?? agentId;
  }

  function rootId(pageId: string): string {
    return pageId.split('/')[0] ?? pageId;
  }

  return (
    <div className={styles.tree}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>Pages</span>
        <button
          className={styles.addButton}
          title="New page"
          onClick={() => setShowCreate(true)}
        >+</button>
      </div>
      {pages.map((page, i) => {
        const isActive = currentPage?.page_id === page.page_id;
        const isRecent = recentlyUpdated.has(page.page_id);
        const prevPage = i > 0 ? pages[i - 1] : null;
        const showSeparator = prevPage && rootId(prevPage.page_id) !== rootId(page.page_id);
        return (
          <div key={page.page_id}>
            {showSeparator && <div className={styles.rootSeparator} />}
            <div
              className={`${styles.pageRow} ${isActive ? styles.pageActive : ''}`}
              style={{ paddingLeft: 4 + (page.page_id.split('/').length - 1) * 16 }}
              onClick={() => onSelectPage(page.page_id)}
            >
              {isRecent && <span className={styles.recentDot}>&bull;</span>}
              <span className={styles.pageLabel}>{shortLabel(page.page_id)}</span>
              <span className={styles.pageOwner}>{ownerName(page.owner)}</span>
            </div>
          </div>
        );
      })}

      {showCreate && (
        <PromptModal
          title="Create SharedSpace page"
          fields={[
            { key: 'pageId', label: 'Page ID', placeholder: 'work/my-page', defaultValue: currentPage ? currentPage.page_id + '/' : '' },
            { key: 'title', label: 'Title', placeholder: 'My Page' },
          ]}
          submitLabel="Create"
          onSubmit={(values) => {
            const pageId = values.pageId?.trim();
            const title = values.title?.trim();
            if (!pageId || !title) return;
            const owner = useAgentsStore.getState().selectedAgentId ?? 'ceo';
            void putSharedSpacePage(pageId, {
              title,
              summary: '',
              owner: owner,
              body: '',
            }).then(() => onSelectPage(pageId));
            setShowCreate(false);
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}
