/**
 * Modal picker shown when the model calls `ask_choice`. Renders the
 * question + 2–4 option rows (title + dimmed summary) + an optional
 * "Let me type my own answer" escape hatch when `allowCustom` is true.
 *
 * The escape hatch matters because DeepSeek flash sometimes misframes
 * the alternatives — none actually fit the user's intent. Without a
 * bailout the user would have to cancel, type feedback, and wait for
 * another round-trip. With it they just type and ship.
 *
 * Border color: magenta — deliberately distinct from cyan (plan),
 * green (checkpoint), red (shell) so the user's eye learns the modes
 * without reading headers.
 */

import { Box } from "ink";
import React from "react";
import type { ChoiceOption } from "../../tools/choice.js";
import { ModalCard } from "./ModalCard.js";
import { SingleSelect } from "./Select.js";

export type ChoiceConfirmChoice =
  | { kind: "pick"; optionId: string }
  | { kind: "custom" }
  | { kind: "cancel" };

export interface ChoiceConfirmProps {
  question: string;
  options: ChoiceOption[];
  allowCustom: boolean;
  onChoose: (choice: ChoiceConfirmChoice) => void;
}

const CUSTOM_VALUE = "__custom__";
const CANCEL_VALUE = "__cancel__";

function ChoiceConfirmInner({ question, options, allowCustom, onChoose }: ChoiceConfirmProps) {
  const items: Array<{ value: string; label: string; hint?: string }> = options.map((opt) => ({
    value: opt.id,
    label: `${opt.id} · ${opt.title}`,
    hint: opt.summary,
  }));
  if (allowCustom) {
    items.push({
      value: CUSTOM_VALUE,
      label: "Let me type my own answer",
      hint: "None of the above fits — type a free-form reply. The model reads it verbatim.",
    });
  }
  items.push({
    value: CANCEL_VALUE,
    label: "Cancel — drop the question",
    hint: "Model stops and asks what you want instead.",
  });

  return (
    <ModalCard accent="#f0abfc" icon="🔀" title="model wants you to pick" subtitle={question}>
      <Box>
        <SingleSelect
          initialValue={options[0]?.id}
          items={items}
          onSubmit={(v) => {
            if (v === CUSTOM_VALUE) onChoose({ kind: "custom" });
            else if (v === CANCEL_VALUE) onChoose({ kind: "cancel" });
            else onChoose({ kind: "pick", optionId: v });
          }}
          onCancel={() => onChoose({ kind: "cancel" })}
          footer="[↑↓] navigate  ·  [Enter] select  ·  [Esc] cancel"
        />
      </Box>
    </ModalCard>
  );
}

export const ChoiceConfirm = React.memo(ChoiceConfirmInner);
