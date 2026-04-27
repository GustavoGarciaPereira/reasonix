import { Box, Text } from "ink";
import React from "react";
import { ModalCard } from "./ModalCard.js";
import { SingleSelect } from "./Select.js";

export type WorkspaceConfirmChoice = "switch" | "deny";

export interface WorkspaceConfirmProps {
  /** Resolved absolute path the model wants to switch to. */
  path: string;
  /** Current session root, shown above the target so the user sees the diff. */
  currentRoot: string;
  /** Number of MCP servers still attached — surfaced so the user knows
   * those won't follow the switch (their child processes were spawned
   * with the original cwd). 0 means no warning. */
  mcpServerCount: number;
  onChoose: (choice: WorkspaceConfirmChoice) => void;
}

/**
 * Modal-style approval for a `change_workspace` tool call. Two
 * choices, Enter / Esc bindings. No "always allow" — workspace
 * switches are per-target by nature.
 */
export function WorkspaceConfirm({
  path,
  currentRoot,
  mcpServerCount,
  onChoose,
}: WorkspaceConfirmProps) {
  const subtitle =
    mcpServerCount > 0
      ? `MCP servers (${mcpServerCount}) stay anchored to the original launch root.`
      : "Re-registers filesystem / shell / memory tools at the new path.";
  return (
    <ModalCard accent="#f59e0b" icon="⇄" title="switch workspace" subtitle={subtitle}>
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text dimColor>{"from "}</Text>
          <Text color="#a3a3a3">{currentRoot}</Text>
        </Box>
        <Box>
          <Text dimColor>{"to   "}</Text>
          <Text color="#67e8f9" bold>
            {path}
          </Text>
        </Box>
      </Box>
      <SingleSelect
        initialValue="switch"
        items={[
          {
            value: "switch",
            label: "Switch",
            hint: "Re-register filesystem / shell / memory tools against the new root.",
          },
          {
            value: "deny",
            label: "Deny",
            hint: "Tell the model the user refused; it will continue without changing directories.",
          },
        ]}
        onSubmit={(v) => onChoose(v as WorkspaceConfirmChoice)}
        onCancel={() => onChoose("deny")}
        footer="[↑↓] navigate  ·  [Enter] select  ·  [Esc] deny"
      />
    </ModalCard>
  );
}
