import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { NativeSessionsPanel } from "./NativeSessionsPanel.js";
import { NativeHandoffPanel } from "./NativeHandoffPanel.js";
import type { NativeWorkspaceController } from "./native-workspace-controller.js";
import { nativeInlineText, nativeProviderLabel } from "./native-session-state.js";

export function nativeProviderDescription(adapterId: string): string {
  return adapterId === "claude" ? "Uses ANTHROPIC_API_KEY and Claude's native permission settings."
    : adapterId === "codex" ? "Uses Codex sign-in, model, and native permissions." : "Uses this provider's native configuration and permissions.";
}
interface Props { controller: NativeWorkspaceController; workspace?: string; back: () => void }
export function ManagedNativeWorkspace({ controller, workspace, back }: Props): React.JSX.Element {
  const [route, setRoute] = useState<"choose" | "native" | "handoff">(controller.selectedService ? "native" : "choose");
  const [freshSelection, setFreshSelection] = useState(false);
  const [selection, setSelection] = useState(0); const [notice, setNotice] = useState<string>();
  const providers = controller.providerIds;
  const provider = providers[Math.min(selection, providers.length - 1)];
  useInput((value, key) => {
    if (key.ctrl && value === "c") return;
    if (key.escape || value === "q") { back(); return; }
    if ((key.downArrow || value === "j") && providers.length) setSelection((index) => (index + 1) % providers.length);
    if ((key.upArrow || value === "k") && providers.length) setSelection((index) => (index + providers.length - 1) % providers.length);
    if (value === "h") {
      if (controller.canBeginHandoff()) { setNotice(undefined); setRoute("handoff"); }
      else setNotice("Close the current native session before reviewing a new-session handoff.");
    }
    if (key.return && provider) {
      try { controller.select(provider); setFreshSelection(true); setNotice(undefined); setRoute("native"); }
      catch (error) { setNotice(error instanceof Error ? error.message : "The native provider is unavailable."); }
    }
  }, { isActive: route === "choose" });
  if (route === "handoff") return <NativeHandoffPanel controller={controller} back={() => setRoute("choose")} opened={() => { setFreshSelection(false); setRoute("native"); }} />;
  if (route === "native" && controller.selectedService) return <NativeSessionsPanel key={controller.selectedId} service={controller.selectedService}
    manager={controller.manager} workspace={workspace} initialRoute={freshSelection ? "workspace" : "choose"} chooseProvider={() => setRoute("choose")} back={back} />;
  return <Box flexDirection="column"><Text bold>Native coding session</Text>
    {providers.map((id, index) => <Text key={id} color={selection === index ? "cyan" : undefined}>{selection === index ? "❯" : " "} {nativeProviderLabel(id)}</Text>)}
    {provider && <Text>{nativeProviderDescription(provider)}</Text>}
    <Text>No Python setup or AceTeam account is required.</Text>
    <Text dimColor>↑↓ Choose  Enter Workspace  h Review local handoff  Esc Back</Text>
    {notice && <Text color="yellow">{nativeInlineText(notice)}</Text>}</Box>;
}
