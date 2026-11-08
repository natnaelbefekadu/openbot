import { Button, Dialog, IconButton, Input, Textarea, X } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, Show } from "solid-js";

/**
 * The file editor: one text file, opened by its absolute path, saved in place.
 *
 * Main refuses what would quietly become a different file — a symlink, a folder, a binary, a file
 * inside a config or secrets folder — so this panel shows the refusal and keeps the buffer.
 */
export function AgentFileEditor(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [path, setPath] = createSignal("");
  const [text, setText] = createSignal("");
  const [saved, setSaved] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const { t } = useText();
  const dirty = () => saved() !== null && text() !== saved();

  // An IPC failure arrives wrapped in the remote-method prefix; the panel shows what is left.
  const reason = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    return message.replace(/^Error invoking remote method '[^']+': (Error\[[^\]]+\]: )?(Error: )?/, "");
  };

  async function load() {
    const target = path().trim();
    if (!target) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const file = await window.openbot.hermesFiles.read({ path: target });
      setText(file.text);
      setSaved(file.text);
      setPath(file.path);
      setStatus(`${t("agentSettings.fileEditor.opened")} ${file.bytes} B`);
    } catch (cause) {
      setError(reason(cause));
      setSaved(null);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const file = await window.openbot.hermesFiles.write({ path: path().trim(), text: text() });
      setSaved(file.text);
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

  return (
    <Dialog.Root open={props.open} onOpenChange={(open) => (open ? props.onOpenChange(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay class="custom-provider-backdrop">
          <Dialog.Content
            as="section"
            class="custom-provider-dialog"
            style={{
              position: "fixed",
              inset: "6vh 8vw",
              display: "flex",
              "flex-direction": "column",
              gap: "10px",
              padding: "16px",
            }}
          >
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
              <Button variant="default" disabled={busy() || saved() === null || !dirty()} onClick={() => void save()}>
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
