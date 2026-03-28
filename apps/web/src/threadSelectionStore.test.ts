import { ThreadId } from "@ocicode/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useThreadSelectionStore } from "./threadSelectionStore";

const threadA = ThreadId.makeUnsafe("thread-a");
const threadB = ThreadId.makeUnsafe("thread-b");
const threadC = ThreadId.makeUnsafe("thread-c");

describe("threadSelectionStore", () => {
  beforeEach(() => {
    useThreadSelectionStore.setState({
      selectedThreadIds: new Set(),
      anchorThreadId: null,
    });
  });

  it("toggles selection and anchors the latest selected thread", () => {
    const store = useThreadSelectionStore.getState();

    store.toggleThread(threadA);

    expect([...useThreadSelectionStore.getState().selectedThreadIds]).toEqual([threadA]);
    expect(useThreadSelectionStore.getState().anchorThreadId).toBe(threadA);

    useThreadSelectionStore.getState().toggleThread(threadA);

    expect(useThreadSelectionStore.getState().selectedThreadIds.size).toBe(0);
    expect(useThreadSelectionStore.getState().anchorThreadId).toBe(threadA);
  });

  it("range-selects between the anchor and the target thread", () => {
    const store = useThreadSelectionStore.getState();

    store.toggleThread(threadA);
    useThreadSelectionStore
      .getState()
      .rangeSelectTo(threadC, [threadA, threadB, threadC] satisfies readonly ThreadId[]);

    expect([...useThreadSelectionStore.getState().selectedThreadIds]).toEqual([
      threadA,
      threadB,
      threadC,
    ]);
    expect(useThreadSelectionStore.getState().anchorThreadId).toBe(threadA);
  });

  it("clears the anchor when the anchored thread is removed from the selection", () => {
    useThreadSelectionStore.setState({
      selectedThreadIds: new Set([threadA, threadB, threadC]),
      anchorThreadId: threadB,
    });

    useThreadSelectionStore.getState().removeFromSelection([threadB, threadC]);

    expect([...useThreadSelectionStore.getState().selectedThreadIds]).toEqual([threadA]);
    expect(useThreadSelectionStore.getState().anchorThreadId).toBeNull();
  });

  it("clears the entire selection state", () => {
    useThreadSelectionStore.setState({
      selectedThreadIds: new Set([threadA, threadB]),
      anchorThreadId: threadA,
    });

    useThreadSelectionStore.getState().clearSelection();

    expect(useThreadSelectionStore.getState().selectedThreadIds.size).toBe(0);
    expect(useThreadSelectionStore.getState().anchorThreadId).toBeNull();
  });
});
