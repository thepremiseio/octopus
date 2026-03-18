import { useEffect, useState } from 'react';
import { useQueuesStore } from '../../store/queues';
import { useAgentsStore } from '../../store/agents';
import { AgentInfo } from '../rightpanel/AgentInfo';
import { ActivityFeed } from '../rightpanel/ActivityFeed';
import { DebugPanel } from '../rightpanel/DebugPanel';
import { PageTree } from '../rightpanel/PageTree';
import type { PanelMode } from './PrimaryPanel';
import styles from './RightPanel.module.css';

type RightTab = 'agent-info' | 'activity-feed' | 'debug' | 'page-tree';

const TAB_LABELS: Record<RightTab, string> = {
  'agent-info': 'agent info',
  'activity-feed': 'activity feed',
  'debug': 'debug',
  'page-tree': 'page tree',
};

interface RightPanelProps {
  primaryMode: PanelMode;
  onSelectPage: (pageId: string) => void;
  onEditClaudeMd?: (agentId: string) => void;
  onViewBoilerplate?: (agentId: string) => void;
}

export function RightPanel({ primaryMode, onSelectPage, onEditClaudeMd, onViewBoilerplate }: RightPanelProps) {
  const selectedItem = useQueuesStore((s) => s.selectedItem);
  const hitlCards = useQueuesStore((s) => s.hitlCards);
  const crossBranchMessages = useQueuesStore((s) => s.crossBranchMessages);
  const selectedAgentId = useAgentsStore((s) => s.selectedAgentId);

  const [activeTab, setActiveTab] = useState<RightTab>('agent-info');

  // Determine context
  const isSharedSpace = primaryMode === 'sharedspace';

  // Find selected card/message details
  const selectedCard = selectedItem?.kind === 'hitl'
    ? hitlCards.find((c) => c.card_id === selectedItem.cardId)
    : null;
  const selectedMessage = selectedItem?.kind === 'crossbranch'
    ? crossBranchMessages.find((m) => m.message_id === selectedItem.messageId)
    : null;

  // Determine the agent to show
  const contextAgentId = selectedCard?.agent_id ?? selectedMessage?.from_agent_id ?? selectedAgentId;
  const contextRunId = selectedCard?.run_id ?? selectedMessage?.run_id ?? null;

  // Determine available tabs and default
  useEffect(() => {
    if (isSharedSpace) {
      setActiveTab('page-tree');
      return;
    }
    if (selectedCard) {
      const isDecision = selectedCard.card_type !== 'fyi';
      setActiveTab(isDecision ? 'activity-feed' : 'agent-info');
      return;
    }
    if (selectedMessage) {
      setActiveTab('agent-info');
      return;
    }
    // Agent selected via tree
    setActiveTab('agent-info');
  }, [isSharedSpace, selectedCard?.card_id, selectedMessage?.message_id, selectedAgentId]);

  if (isSharedSpace) {
    return (
      <aside className={styles.panel}>
        <div className={styles.tabs}>
          <button className={`${styles.tab} ${styles.tabActive}`}>page tree</button>
        </div>
        <div className={styles.body}>
          <PageTree onSelectPage={onSelectPage} />
        </div>
      </aside>
    );
  }

  const showTabs = contextAgentId !== null;
  const tabs: RightTab[] = ['agent-info', 'activity-feed', 'debug'];

  return (
    <aside className={styles.panel}>
      {showTabs && (
        <div className={styles.tabs}>
          {tabs.map((tab) => (
            <button
              key={tab}
              className={`${styles.tab} ${activeTab === tab ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>
      )}
      <div className={styles.body}>
        {!contextAgentId && (
          <div className={styles.empty}>Select an agent or card</div>
        )}
        {contextAgentId && activeTab === 'agent-info' && (
          <AgentInfo
            agentId={contextAgentId}
            onEditClaudeMd={onEditClaudeMd}
            onViewBoilerplate={onViewBoilerplate}
          />
        )}
        {contextAgentId && activeTab === 'activity-feed' && contextRunId && (
          <ActivityFeed agentId={contextAgentId} runId={contextRunId} />
        )}
        {contextAgentId && activeTab === 'activity-feed' && !contextRunId && (
          <div className={styles.empty}>No run selected</div>
        )}
        {contextAgentId && activeTab === 'debug' && (
          <DebugPanel agentId={contextAgentId} />
        )}
      </div>
    </aside>
  );
}
