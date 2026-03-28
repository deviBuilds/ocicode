import { Schema } from "effect";
import { useMemo } from "react";
import { EditorId, EDITORS, type NativeApi } from "@ocicode/contracts";

import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";

const LAST_EDITOR_KEY = "ocicode:last-editor";
const NullableEditorIdSchema: Schema.Schema<EditorId | null> = Schema.NullOr(EditorId);

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage<EditorId | null>(
    LAST_EDITOR_KEY,
    null,
    NullableEditorIdSchema,
  );

  const effectiveEditor = useMemo(() => {
    if (lastEditor && availableEditors.includes(lastEditor)) {
      return lastEditor;
    }
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [availableEditors, lastEditor]);

  return [effectiveEditor, setLastEditor] as const;
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored = getLocalStorageItem(LAST_EDITOR_KEY, NullableEditorIdSchema);
  if (stored && availableEditorIds.has(stored)) {
    return stored;
  }
  const editor = EDITORS.find((entry) => availableEditorIds.has(entry.id))?.id ?? null;
  if (editor) {
    setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
  }
  return editor ?? null;
}

export async function openInPreferredEditor(api: NativeApi, targetPath: string): Promise<EditorId> {
  const { availableEditors } = await api.server.getConfig();
  const editor = resolveAndPersistPreferredEditor(availableEditors);
  if (!editor) {
    throw new Error("No available editors found.");
  }
  await api.shell.openInEditor(targetPath, editor);
  return editor;
}
