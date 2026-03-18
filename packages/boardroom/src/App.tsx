import { useCallback, useEffect, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useKeyboard } from './hooks/useKeyboard';
import { Topbar } from './components/layout/Topbar';
import { AgentTree } from './components/layout/AgentTree';
import { PrimaryPanel } from './components/layout/PrimaryPanel';
import type { PanelMode } from './components/layout/PrimaryPanel';
import { RightPanel } from './components/layout/RightPanel';
import { CommandPalette } from './components/common/CommandPalette';
import { ClaudeMdEditor } from './components/editor/ClaudeMdEditor';
import { BoilerplateViewer } from './components/editor/BoilerplateViewer';
import { initAgentsSubscriptions, useAgentsStore } from './store/agents';
import { initQueuesSubscriptions, useQueuesStore } from './store/queues';
import { initChatSubscriptions, useChatStore } from './store/chat';
import { initSharedSpaceSubscriptions, useSharedSpaceStore } from './store/sharedspace';
import { initCostSubscriptions } from './store/cost';
import { on } from './api/websocket';
import { getAgents, getHitlCards, getCrossBranchMessages, getSharedSpacePage, createConversation } from './api/rest';
import { QueueMode } from './components/queue/QueueMode';
import { ChatMode } from './components/chat/ChatMode';
import { SharedSpaceMode } from './components/sharedspace/SharedSpaceMode';
import { CostOverview } from './components/layout/CostOverview';
import styles from './App.module.css';

// Initialize WS → store subscriptions once
let subsInitialized = false;
function ensureSubscriptions() {
  if (subsInitialized) return;
  subsInitialized = true;
  initAgentsSubscriptions();
  initQueuesSubscriptions();
  initChatSubscriptions();
  initSharedSpaceSubscriptions();
  initCostSubscriptions();
}

// Track which agent is being edited/viewed in editor modes
interface EditorTarget {
  agentId: string;
}

export function App() {
  const { connectionStatus } = useWebSocket();
  const [mode, setMode] = useState<PanelMode>('queue');
  const [prevMode, setPrevMode] = useState<PanelMode>('queue');
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [showPalette, setShowPalette] = useState(false);

  useEffect(() => {
    ensureSubscriptions();
  }, []);

  // After connection.state arrives, reconcile full state via REST
  useEffect(() => {
    const unsub = on('connection.state', () => {
      void Promise.all([
        getAgents().then((r) => useAgentsStore.getState().seedFromRestResponse(r.agents)),
        getHitlCards().then((r) => useQueuesStore.getState().seedHitlCards(r.cards)),
        getCrossBranchMessages().then((r) => useQueuesStore.getState().seedCrossBranchMessages(r.messages)),
      ]);
    });
    return unsub;
  }, []);

  const handleOpenCostOverview = useCallback(() => setMode('cost'), []);

  const handleSelectPage = useCallback((pageId: string) => {
    void getSharedSpacePage(pageId).then((p) => {
      useSharedSpaceStore.getState().setCurrentPage(p);
    });
  }, []);

  const handleSelectAgent = useCallback((agentId: string) => {
    useAgentsStore.getState().setSelectedAgent(agentId);
    useChatStore.getState().setActiveAgent(agentId);
    setMode('chat');
  }, []);

  const handleChatWith = useCallback((agentId: string) => {
    useAgentsStore.getState().setSelectedAgent(agentId);
    useChatStore.getState().setActiveAgent(agentId);
    setMode('chat');
  }, []);

  const handleNewConversation = useCallback(() => {
    const agentId = useChatStore.getState().activeAgentId;
    if (!agentId) return;
    void createConversation(agentId).then((r) => {
      useChatStore.getState().newConversation(agentId, r.conversation_id);
    });
  }, []);

  const handleEditClaudeMd = useCallback((agentId: string) => {
    setEditorTarget({ agentId });
    setPrevMode(mode);
    setMode('claudemd');
  }, [mode]);

  const handleViewBoilerplate = useCallback((agentId: string) => {
    setEditorTarget({ agentId });
    setPrevMode(mode);
    setMode('boilerplate');
  }, [mode]);

  const handleEditorClose = useCallback(() => {
    setMode(prevMode);
    setEditorTarget(null);
  }, [prevMode]);

  useKeyboard({
    onSetMode: setMode,
    onOpenCommandPalette: useCallback(() => setShowPalette(true), []),
    onNewConversation: handleNewConversation,
  });

  return (
    <div className={styles.app}>
      <Topbar connectionStatus={connectionStatus} onOpenCostOverview={handleOpenCostOverview} />
      <div className={styles.body}>
        <AgentTree onOpenCostOverview={handleOpenCostOverview} onSelectAgent={handleSelectAgent} />
        <PrimaryPanel mode={mode} onSetMode={setMode}>
          {mode === 'queue' && <QueueMode />}
          {mode === 'chat' && <ChatMode />}
          {mode === 'sharedspace' && <SharedSpaceMode />}
          {mode === 'cost' && <CostOverview />}
          {mode === 'claudemd' && editorTarget && (
            <ClaudeMdEditor agentId={editorTarget.agentId} onClose={handleEditorClose} />
          )}
          {mode === 'boilerplate' && editorTarget && (
            <BoilerplateViewer agentId={editorTarget.agentId} onClose={handleEditorClose} />
          )}
        </PrimaryPanel>
        <RightPanel
          primaryMode={mode}
          onSelectPage={handleSelectPage}
          onEditClaudeMd={handleEditClaudeMd}
          onViewBoilerplate={handleViewBoilerplate}
        />
      </div>
      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          onChatWith={handleChatWith}
          onSetMode={setMode}
        />
      )}
    </div>
  );
}
