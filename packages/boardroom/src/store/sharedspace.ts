import { create } from 'zustand';
import type { SharedSpacePage, SharedSpacePageFull } from '../types/api';
import { on } from '../api/websocket';

/** Sort pages into tree order: parent before children, siblings alphabetically. */
function sortPagesTree(pages: SharedSpacePage[]): SharedSpacePage[] {
  return [...pages].sort((a, b) => a.page_id.localeCompare(b.page_id));
}

interface SharedSpaceState {
  pages: SharedSpacePage[];
  currentPage: SharedSpacePageFull | null;
  recentlyUpdated: Set<string>;

  seedPageIndex: (pages: SharedSpacePage[]) => void;
  upsertPageMeta: (page: SharedSpacePage) => void;
  deletePage: (pageId: string) => void;
  setCurrentPage: (page: SharedSpacePageFull | null) => void;
  markRecentlyUpdated: (pageId: string) => void;
}

export const useSharedSpaceStore = create<SharedSpaceState>((set) => ({
  pages: [],
  currentPage: null,
  recentlyUpdated: new Set(),

  seedPageIndex: (pages) => set({ pages: sortPagesTree(pages) }),

  upsertPageMeta: (page) =>
    set((state) => {
      const idx = state.pages.findIndex((p) => p.page_id === page.page_id);
      let next: SharedSpacePage[];
      if (idx >= 0) {
        next = [...state.pages];
        next[idx] = page;
      } else {
        next = [...state.pages, page];
      }
      return { pages: sortPagesTree(next) };
    }),

  deletePage: (pageId) =>
    set((state) => ({
      pages: state.pages.filter((p) => p.page_id !== pageId),
      currentPage: state.currentPage?.page_id === pageId ? null : state.currentPage,
    })),

  setCurrentPage: (page) => set({ currentPage: page }),

  markRecentlyUpdated: (pageId) =>
    set((state) => {
      const next = new Set(state.recentlyUpdated);
      next.add(pageId);
      return { recentlyUpdated: next };
    }),
}));

// ─── WS subscriptions ───────────────────────────────────────────────────────

export function initSharedSpaceSubscriptions(): void {
  on('sharedspace.page.updated', (payload) => {
    if (payload.operation === 'deleted') {
      useSharedSpaceStore.getState().deletePage(payload.page_id);
    } else {
      useSharedSpaceStore.getState().upsertPageMeta({
        page_id: payload.page_id,
        title: payload.title,
        summary: payload.summary,
        owner_agent_id: payload.owner_agent_id,
        updated_by_agent_id: payload.updated_by_agent_id,
        updated_ts: Date.now(),
        parent_id: payload.parent_id ?? null,
        depth: payload.depth ?? 0,
      });
    }
    useSharedSpaceStore.getState().markRecentlyUpdated(payload.page_id);
  });
}
