/**
 * Minimal arrow-key list components for Ink — single-select and
 * multi-select. No external deps beyond Ink's `useInput`.
 *
 * Why hand-roll: `ink-select-input` exists, but it defaults to
 * Enter-only interaction (no space-to-toggle for multi-select), doesn't
 * expose the "hint / footer" slot we want under each item, and would be
 * another dep for ~60 lines of UI code. Reasonix already has one React
 * rendering quirk bundled (`ink-text-input`); adding more is low value.
 */

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { recoverCsiTail } from "./key-normalize.js";

export interface SelectItem<V extends string = string> {
  /** Stable identifier — returned to caller on submit. */
  value: V;
  /** First-row label. */
  label: string;
  /** Optional second row rendered dimmed. */
  hint?: string;
  /** If true, item is not selectable (rendered dimmed, skipped on nav). */
  disabled?: boolean;
}

export interface SingleSelectProps<V extends string> {
  items: SelectItem<V>[];
  initialValue?: V;
  onSubmit: (value: V) => void;
  onCancel?: () => void;
  /**
   * Optional footer rendered dim beneath the list, e.g.
   * `"[↑↓] navigate · [Enter] select · [Esc] cancel"`. Makes keyboard
   * affordances discoverable — otherwise new users hit `y`/`n` and
   * wonder why nothing happens.
   */
  footer?: string;
}

export function SingleSelect<V extends string>({
  items,
  initialValue,
  onSubmit,
  onCancel,
  footer,
}: SingleSelectProps<V>) {
  const initialIndex = Math.max(
    0,
    items.findIndex((i) => i.value === initialValue && !i.disabled),
  );
  const [index, setIndex] = useState(initialIndex === -1 ? 0 : initialIndex);

  useInput((rawInput, rawKey) => {
    const recovered = recoverCsiTail(rawInput, rawKey);
    const key = recovered ? { ...rawKey, ...recovered } : rawKey;
    if (key.upArrow) {
      setIndex((i) => findNextEnabled(items, i, -1));
    } else if (key.downArrow) {
      setIndex((i) => findNextEnabled(items, i, +1));
    } else if (key.return) {
      const chosen = items[index];
      if (chosen && !chosen.disabled) onSubmit(chosen.value);
    } else if (key.escape && onCancel) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <SelectRow
          key={item.value}
          item={item}
          active={i === index}
          marker={i === index ? "▸" : " "}
        />
      ))}
      {footer ? (
        <Box marginTop={1}>
          <Text dimColor>{footer}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export interface MultiSelectProps<V extends string> {
  items: SelectItem<V>[];
  initialSelected?: V[];
  onSubmit: (values: V[]) => void;
  onCancel?: () => void;
  /** Footer hint under the list — e.g. "[Space] toggle · [Enter] confirm". */
  footer?: string;
}

export function MultiSelect<V extends string>({
  items,
  initialSelected = [],
  onSubmit,
  onCancel,
  footer,
}: MultiSelectProps<V>) {
  const [index, setIndex] = useState(() => {
    const first = items.findIndex((i) => !i.disabled);
    return first === -1 ? 0 : first;
  });
  const [selected, setSelected] = useState<Set<V>>(new Set(initialSelected));

  useInput((rawInput, rawKey) => {
    const recovered = recoverCsiTail(rawInput, rawKey);
    const input = recovered ? "" : rawInput;
    const key = recovered ? { ...rawKey, ...recovered } : rawKey;
    if (key.upArrow) {
      setIndex((i) => findNextEnabled(items, i, -1));
    } else if (key.downArrow) {
      setIndex((i) => findNextEnabled(items, i, +1));
    } else if (input === " ") {
      const item = items[index];
      if (!item || item.disabled) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(item.value)) next.delete(item.value);
        else next.add(item.value);
        return next;
      });
    } else if (key.return) {
      // Preserve catalog order rather than insertion order, so reruns
      // produce the same spec list for the same checkbox set — makes the
      // `config.json` diff trivially stable.
      const ordered = items.filter((i) => selected.has(i.value)).map((i) => i.value);
      onSubmit(ordered);
    } else if (key.escape && onCancel) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const checked = selected.has(item.value);
        const marker = checked ? "[x]" : "[ ]";
        return (
          <SelectRow
            key={item.value}
            item={item}
            active={i === index}
            marker={`${i === index ? "▸" : " "} ${marker}`}
          />
        );
      })}
      {footer ? (
        <Box marginTop={1}>
          <Text dimColor>{footer}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ---------- internals ----------

function SelectRow<V extends string>({
  item,
  active,
  marker,
}: {
  item: SelectItem<V>;
  active: boolean;
  marker: string;
}) {
  const color = item.disabled ? "gray" : active ? "cyan" : undefined;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>
          {marker} {item.label}
        </Text>
      </Box>
      {item.hint ? (
        <Box paddingLeft={marker.length + 1}>
          <Text dimColor>{item.hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function findNextEnabled<V extends string>(
  items: SelectItem<V>[],
  from: number,
  step: -1 | 1,
): number {
  if (items.length === 0) return 0;
  let i = from;
  for (let tries = 0; tries < items.length; tries++) {
    i = (i + step + items.length) % items.length;
    if (!items[i]?.disabled) return i;
  }
  return from;
}
