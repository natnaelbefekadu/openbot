import { Button, Dialog, IconButton, Input, Textarea, X } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, Show } from "solid-js";

/**
 * The file editor: one text file, opened by its absolute path, saved over itself.
 *
 * Main refuses what would quietly become a different file — a symlink, a hardlink, a folder, a
 * binary, a file that is not UTF-8, one that changed since it was opened — so the panel shows the
 * refusal and keeps the buffer. A save always targets the file that was loaded, never whatever the
 * path field happens to say now.
 */
export function AgentFileEditor(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useText();
  const [path, setPath] = createSignal("");
  const [loadedPath, setLoadedPath] = createSignal<string | null>(null);
  const [loadedAt, setLoadedAt] = createSignal<string | null>(null);
  const [text, setText] = createSignal("");
  const [saved, setSaved] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const dirty = () => saved() !== null && text() !== saved();
  const detached = () => loadedPath() !== null && path().trim() !== loadedPath();

  // An IPC failure arrives wrapped in the remote-method prefix; the panel shows what is left.
  const reason = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    return message.replace(/^Error invoking remote method '[^']+': (Error\[[^\]]+\]: )?(Error: )?/, "");
  };

  async function load(target = path().trim()) {
    if (!target) return;
    if (dirty() && !detached()) {
      setError("Save or discard the changes in this file before opening another one.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const file = await window.openbot.hermesFiles.read({ path: target });
      setText(file.text);
      setSaved(file.text);
      setPath(file.path);
      setLoadedPath(file.path);
      setLoadedAt(file.modifiedAt);
      setStatus(`${t("agentSettings.fileEditor.opened")} ${file.bytes} B`);
    } catch (cause) {
      // A failed open must not leave a buffer that looks saved: nothing is loaded.
      setError(reason(cause));
      setText("");
      setSaved(null);
      setLoadedPath(null);
      setLoadedAt(null);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const target = loadedPath();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const at = loadedAt();
      const file = await window.openbot.hermesFiles.write(
        at ? { path: target, text: text(), modifiedAt: at } : { path: target, text: text() },
      );
      setSaved(file.text);
      setLoadedAt(file.modifiedAt);
      setStatus(`${t("agentSettings.fileEditor.saved")} ${file.bytes} B · ${t("agentSettings.fileEditor.backup")}`);
    } catch (cause) {
      setError(reason(cause));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (dirty()) {
      setError(t("agentSettings.fileEditor.unsaved"));
      return;
    }
    setError(null);
    setStatus(null);
    props.onOpenChange(false);
  }

  // Reopening shows what is on disk now, which is what the agent may have changed since.
  createEffect(
    () => props.open,
    (open) => {
      if (!open) return;
      // Ran inside the effect, so the read is the effect's own, not a dependency of the compute.
      const target = loadedPath();
      if (target && !dirty()) void load(target);
    },
  );

  return (
    <Dialog.Root open={props.open} onOpenChange={(open) => (open ? props.onOpenChange(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay class="custom-provider-backdrop">
          <Dialog.Content as="section" class="custom-provider-dialog">
            <header style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <Dialog.Title as="h2" style={{ margin: "0", "font-size": "var(--text-md)", flex: "1" }}>
                {t("agentSettings.links.fileEditor")}
              </Dialog.Title>
              <IconButton label={t("agentSettings.fileEditor.close")} variant="ghost" onClick={close}>
                <X />
              </IconButton>
            </header>
            <div style={{ display: "flex", gap: "8px" }}>
              <Input
                type="text"
                aria-label={t("agentSettings.fileEditor.path")}
                placeholder={t("agentSettings.fileEditor.path")}
                autocomplete="off"
                value={path()}
                onValueChange={setPath}
                onKeyDown={(event: KeyboardEvent) => {
                  if (event.key === "Enter") void load();
                }}
                style={{ flex: "1", "font-family": "ui-monospace, monospace" }}
              />
              <Button variant="secondary" disabled={busy() || !path().trim()} onClick={() => void load()}>
                {t("agentSettings.fileEditor.openFile")}
              </Button>
            </div>
            <Textarea
              aria-label={t("agentSettings.fileEditor.contents")}
              spellcheck={false}
              value={text()}
              onValueChange={setText}
              style={{
                flex: "1",
                "min-height": "200px",
                width: "100%",
                resize: "none",
                "font-family": "ui-monospace, monospace",
              }}
            />
            <footer style={{ display: "flex", "align-items": "center", gap: "10px", "font-size": "var(--text-sm)" }}>
              <Button
                variant="default"
                disabled={busy() || loadedPath() === null || !dirty() || detached()}
                onClick={() => void save()}
              >
                {t("agentSettings.fileEditor.saveFile")}
              </Button>
              <Show when={dirty()}>
                <span style={{ opacity: "0.7" }}>{t("agentSettings.fileEditor.dirty")}</span>
              </Show>
              <Show when={status()}>{(message) => <span style={{ opacity: "0.7" }}>{message()}</span>}</Show>
              <Show when={error()}>{(message) => <span style={{ color: "var(--danger)" }}>{message()}</span>}</Show>
            </footer>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
