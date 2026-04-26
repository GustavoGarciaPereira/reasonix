/**
 * Shared visual frame for confirmation modals (ChoiceConfirm,
 * PlanConfirm, ShellConfirm, EditConfirm, PlanCheckpointConfirm,
 * PlanReviseConfirm). Each modal opens inside the live region — so
 * we keep the frame to plain Text rules and bg-pill headers, no
 * Ink `borderStyle` (that's the eraseLines miscount class of bug).
 *
 * Layout:
 *
 *   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
 *      [ ICON  TITLE ]    optional subtitle
 *
 *      <children — body of the modal>
 *
 *   ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁
 *
 * Color drives the accent (top + bottom rules + title pill bg)
 * so the user learns to recognize "magenta = choice", "cyan =
 * plan", "red = shell", "yellow = edit review" by sight.
 */

import { Box, Text, useStdout } from "ink";
// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope
import React from "react";

export interface ModalCardProps {
  /** Accent color — title pill bg + top/bottom rule color. */
  accent: string;
  /** Section title shown in the bg-pill header. */
  title: string;
  /** Optional dim subtitle next to the title. */
  subtitle?: string;
  /** Optional leading glyph inside the title pill (icon). */
  icon?: string;
  children: React.ReactNode;
}

export function ModalCard({
  accent,
  title,
  subtitle,
  icon,
  children,
}: ModalCardProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const ruleWidth = Math.min(80, Math.max(28, cols - 4));
  const titleText = icon ? ` ${icon}  ${title} ` : ` ${title} `;
  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
      <Box>
        <Text color={accent}>{"▔".repeat(ruleWidth)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text backgroundColor={accent} color="black" bold>
          {titleText}
        </Text>
        {subtitle ? <Text dimColor>{`   ${subtitle}`}</Text> : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
      <Box marginTop={1}>
        <Text color={accent} dimColor>
          {"▁".repeat(ruleWidth)}
        </Text>
      </Box>
    </Box>
  );
}
