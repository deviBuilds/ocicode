import { type EditorId, type ResolvedKeybindingsConfig } from "@ocicode/contracts";
import { memo, useCallback, useEffect, useMemo } from "react";
import { ChevronDownIcon, FolderClosedIcon } from "lucide-react";

import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "~/keybindings";
import { usePreferredEditor } from "~/editorPreferences";
import { CursorIcon, type Icon, VisualStudioCode, Zed } from "../Icons";
import { readNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";

const resolveOptions = (
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
): ReadonlyArray<{ label: string; Icon: Icon; value: EditorId }> => {
  const baseOptions: ReadonlyArray<{ label: string; Icon: Icon; value: EditorId }> = [
    { label: "Cursor", Icon: CursorIcon, value: "cursor" },
    { label: "VS Code", Icon: VisualStudioCode, value: "vscode" },
    { label: "VS Code Insiders", Icon: VisualStudioCode, value: "vscode-insiders" },
    { label: "VSCodium", Icon: VisualStudioCode, value: "vscodium" },
    { label: "Zed", Icon: Zed, value: "zed" },
    {
      label: isMacPlatform(platform)
        ? "Finder"
        : isWindowsPlatform(platform)
          ? "Explorer"
          : "Files",
      Icon: FolderClosedIcon,
      value: "file-manager",
    },
  ];
  return baseOptions.filter((option) => availableEditors.includes(option.value));
};

export const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors,
  openInCwd,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = useMemo(
    () => resolveOptions(navigator.platform, availableEditors),
    [availableEditors],
  );
  const effectiveEditor =
    preferredEditor && options.some((option) => option.value === preferredEditor)
      ? preferredEditor
      : (options[0]?.value ?? null);
  const primaryOption = options.find(({ value }) => value === effectiveEditor) ?? null;

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readNativeApi();
      if (!api || !openInCwd) return;
      const editor = editorId ?? effectiveEditor;
      if (!editor) return;
      void api.shell.openInEditor(openInCwd, editor);
      setPreferredEditor(editor);
    },
    [effectiveEditor, openInCwd, setPreferredEditor],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const api = readNativeApi();
      if (!isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!api || !openInCwd || !effectiveEditor) return;

      event.preventDefault();
      void api.shell.openInEditor(openInCwd, effectiveEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [effectiveEditor, keybindings, openInCwd]);

  return (
    <Group aria-label="Open in editor actions">
      <Button
        size="xs"
        variant="outline"
        disabled={!effectiveEditor || !openInCwd}
        onClick={() => openInEditor(effectiveEditor)}
      >
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          Open
        </span>
      </Button>
      <GroupSeparator className="hidden @3xl/header-actions:block" />
      <Menu>
        <MenuTrigger
          render={<Button aria-label="Open in options" size="icon-xs" variant="outline" />}
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
          {options.map(({ label, Icon, value }) => (
            <MenuItem key={value} onClick={() => openInEditor(value)}>
              <Icon aria-hidden="true" className="text-muted-foreground" />
              {label}
              {value === effectiveEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
