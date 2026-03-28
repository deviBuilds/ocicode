import { type ThreadId } from "@ocicode/contracts";
import { create } from "zustand";

export interface ThreadSelectionState {
  selectedThreadIds: ReadonlySet<ThreadId>;
  anchorThreadId: ThreadId | null;
}

interface ThreadSelectionStore extends ThreadSelectionState {
  toggleThread: (threadId: ThreadId) => void;
  rangeSelectTo: (threadId: ThreadId, orderedThreadIds: readonly ThreadId[]) => void;
  clearSelection: () => void;
  removeFromSelection: (threadIds: readonly ThreadId[]) => void;
  setAnchor: (threadId: ThreadId) => void;
}

const EMPTY_SET = new Set<ThreadId>();

export const useThreadSelectionStore = create<ThreadSelectionStore>((set, get) => ({
  selectedThreadIds: EMPTY_SET,
  anchorThreadId: null,

  toggleThread: (threadId) => {
    set((state) => {
      const next = new Set(state.selectedThreadIds);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return {
        selectedThreadIds: next,
        anchorThreadId: next.has(threadId) ? threadId : state.anchorThreadId,
      };
    });
  },

  rangeSelectTo: (threadId, orderedThreadIds) => {
    set((state) => {
      const anchor = state.anchorThreadId;
      if (anchor === null) {
        const next = new Set(state.selectedThreadIds);
        next.add(threadId);
        return { selectedThreadIds: next, anchorThreadId: threadId };
      }

      const anchorIndex = orderedThreadIds.indexOf(anchor);
      const targetIndex = orderedThreadIds.indexOf(threadId);
      if (anchorIndex === -1 || targetIndex === -1) {
        const next = new Set(state.selectedThreadIds);
        next.add(threadId);
        return { selectedThreadIds: next, anchorThreadId: threadId };
      }

      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const next = new Set(state.selectedThreadIds);
      for (let index = start; index <= end; index += 1) {
        const id = orderedThreadIds[index];
        if (id) {
          next.add(id);
        }
      }
      return { selectedThreadIds: next, anchorThreadId: anchor };
    });
  },

  clearSelection: () => {
    const state = get();
    if (state.selectedThreadIds.size === 0 && state.anchorThreadId === null) {
      return;
    }
    set({ selectedThreadIds: EMPTY_SET, anchorThreadId: null });
  },

  removeFromSelection: (threadIds) => {
    set((state) => {
      const toRemove = new Set(threadIds);
      let changed = false;
      const next = new Set<ThreadId>();
      for (const id of state.selectedThreadIds) {
        if (toRemove.has(id)) {
          changed = true;
        } else {
          next.add(id);
        }
      }
      if (!changed) {
        return state;
      }
      return {
        selectedThreadIds: next,
        anchorThreadId:
          state.anchorThreadId !== null && toRemove.has(state.anchorThreadId)
            ? null
            : state.anchorThreadId,
      };
    });
  },

  setAnchor: (threadId) => {
    if (get().anchorThreadId === threadId) {
      return;
    }
    set({ anchorThreadId: threadId });
  },
}));
