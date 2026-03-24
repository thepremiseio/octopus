import { useCallback, useEffect, useMemo, useState } from 'react';
import { ws } from './api';
import { registerPush } from './push';
import { ConnectionBar } from './components/ConnectionBar';
import { AgentList } from './screens/AgentList';
import { Conversation } from './screens/Conversation';
import { ShareTarget } from './screens/ShareTarget';
import styles from './App.module.css';

type Screen =
  | { type: 'list' }
  | { type: 'chat'; agentId: string; conversationId?: string; prefill?: string }
  | { type: 'share'; text: string };

function parseShareParams(): string | null {
  const params = new URLSearchParams(window.location.search);
  const parts: string[] = [];
  const title = params.get('title');
  const text = params.get('text');
  const url = params.get('url');
  if (title) parts.push(title);
  if (text) parts.push(text);
  if (url) parts.push(url);
  if (parts.length === 0) return null;
  // Clean up the URL so refreshing doesn't re-trigger share
  window.history.replaceState({}, '', '/');
  return parts.join('\n');
}

export function App() {
  const sharedText = useMemo(() => parseShareParams(), []);
  const [screen, setScreen] = useState<Screen>(
    sharedText ? { type: 'share', text: sharedText } : { type: 'list' },
  );

  useEffect(() => {
    ws.init();
    registerPush();
    return () => ws.destroy();
  }, []);

  // Handle back gesture / hardware back button
  useEffect(() => {
    function handlePopState() {
      setScreen({ type: 'list' });
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleSelectAgent = useCallback((agentId: string, conversationId?: string) => {
    window.history.pushState({}, '', `/chat/${agentId}`);
    setScreen({ type: 'chat', agentId, conversationId });
  }, []);

  const handleBack = useCallback(() => {
    window.history.back();
  }, []);

  const handleShareSelect = useCallback((agentId: string, text: string) => {
    window.history.pushState({}, '', `/chat/${agentId}`);
    setScreen({ type: 'chat', agentId, prefill: text });
  }, []);

  const handleShareCancel = useCallback(() => {
    setScreen({ type: 'list' });
  }, []);

  return (
    <div className={styles.app}>
      <ConnectionBar />
      {screen.type === 'list' && <AgentList onSelect={handleSelectAgent} />}
      {screen.type === 'chat' && (
        <Conversation
          agentId={screen.agentId}
          conversationId={screen.conversationId}
          prefill={screen.prefill}
          onBack={handleBack}
        />
      )}
      {screen.type === 'share' && (
        <ShareTarget
          sharedText={screen.text}
          onSelect={handleShareSelect}
          onCancel={handleShareCancel}
        />
      )}
    </div>
  );
}
