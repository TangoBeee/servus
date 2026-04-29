import React from "react";
import { Box, Text } from "ink";
import { COLORS } from "../theme.js";

type InkKeyLike = {
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  ctrl?: boolean;
  meta?: boolean;
};

export interface ComposerEditResult {
  handled: boolean;
  value: string;
  cursor: number;
}

export function applyComposerTextInput(
  value: string,
  cursor: number,
  input: string,
  key: InkKeyLike,
): ComposerEditResult {
  const safeCursor = clamp(cursor, 0, value.length);
  if (hasLiteralBackspace(input)) {
    return applyLiteralInputSequence(value, safeCursor, input);
  }
  if (key.leftArrow) {
    return { handled: true, value, cursor: Math.max(0, safeCursor - 1) };
  }
  if (key.rightArrow) {
    return { handled: true, value, cursor: Math.min(value.length, safeCursor + 1) };
  }
  const backspaceLike = key.backspace;
  const deleteLike = key.delete;
  if (backspaceLike) {
    if (safeCursor === 0) return { handled: true, value, cursor: 0 };
    return {
      handled: true,
      value: value.slice(0, safeCursor - 1) + value.slice(safeCursor),
      cursor: safeCursor - 1,
    };
  }
  if (deleteLike && isForwardDeleteSequence(input)) {
    if (safeCursor >= value.length) return { handled: true, value, cursor: safeCursor };
    return {
      handled: true,
      value: value.slice(0, safeCursor) + value.slice(safeCursor + 1),
      cursor: safeCursor,
    };
  }
  if (deleteLike) {
    if (safeCursor === 0) return { handled: true, value, cursor: 0 };
    return {
      handled: true,
      value: value.slice(0, safeCursor - 1) + value.slice(safeCursor),
      cursor: safeCursor - 1,
    };
  }
  if (key.ctrl && input === "a") return { handled: true, value, cursor: 0 };
  if (key.ctrl && input === "e") return { handled: true, value, cursor: value.length };
  if (key.ctrl && input === "u") return { handled: true, value: value.slice(safeCursor), cursor: 0 };
  if (key.ctrl && input === "k") return { handled: true, value: value.slice(0, safeCursor), cursor: safeCursor };
  if (key.ctrl && input === "w") {
    const left = value.slice(0, safeCursor).replace(/\s*\S+\s*$/, "");
    return { handled: true, value: left + value.slice(safeCursor), cursor: left.length };
  }
  if (key.ctrl || key.meta) return { handled: false, value, cursor: safeCursor };

  const printable = input.replace(/[\r\n\t\u007f\b\x08]/g, "");
  if (!printable) return { handled: false, value, cursor: safeCursor };
  return {
    handled: true,
    value: value.slice(0, safeCursor) + printable + value.slice(safeCursor),
    cursor: safeCursor + printable.length,
  };
}

export function normalizeComposerCursor(value: string, cursor: number): number {
  return clamp(cursor, 0, value.length);
}

export function StableComposerInput({
  value,
  cursor,
  width,
  maxLines = 3,
  placeholder,
  active = true,
}: {
  value: string;
  cursor: number;
  width: number;
  maxLines?: number;
  placeholder: string;
  active?: boolean;
}) {
  const safeWidth = Math.max(12, width);
  const safeCursor = normalizeComposerCursor(value, cursor);
  if (!value) {
    const placeholderText = truncateMiddle(placeholder, Math.max(8, safeWidth - 3));
    return (
      <Box flexDirection="column" height={maxLines}>
        <Text>
          <Text inverse={active}> </Text>
          <Text color="gray"> {placeholderText}</Text>
        </Text>
        {Array.from({ length: maxLines - 1 }).map((_, index) => (
          <Text key={`blank-${index}`}> </Text>
        ))}
      </Box>
    );
  }

  const marker = "\uE000";
  const withCursor = `${value.slice(0, safeCursor)}${marker}${value.slice(safeCursor)}`;
  const lines = wrapRawInput(withCursor, safeWidth);
  const visible = lines.slice(-maxLines);
  const padding = Math.max(0, maxLines - visible.length);

  return (
    <Box flexDirection="column" height={maxLines}>
      {visible.map((line, index) => (
        <InputLine key={`${index}:${line}`} line={line} marker={marker} active={active} />
      ))}
      {Array.from({ length: padding }).map((_, index) => (
        <Text key={`pad-${index}`}> </Text>
      ))}
    </Box>
  );
}

function hasLiteralBackspace(input: string): boolean {
  return /[\u007f\b\x08]/.test(input);
}

function isForwardDeleteSequence(input: string): boolean {
  return input === "\x1b[3~" || input.includes("[3~");
}

function applyLiteralInputSequence(value: string, cursor: number, input: string): ComposerEditResult {
  let nextValue = value;
  let nextCursor = cursor;
  for (const char of input) {
    if (char === "\u007f" || char === "\b" || char === "\x08") {
      if (nextCursor > 0) {
        nextValue = nextValue.slice(0, nextCursor - 1) + nextValue.slice(nextCursor);
        nextCursor -= 1;
      }
      continue;
    }
    if (char === "\r" || char === "\n" || char === "\t") continue;
    nextValue = nextValue.slice(0, nextCursor) + char + nextValue.slice(nextCursor);
    nextCursor += char.length;
  }
  return { handled: true, value: nextValue, cursor: nextCursor };
}

function InputLine({ line, marker, active }: { line: string; marker: string; active: boolean }) {
  const cursorIndex = line.indexOf(marker);
  if (cursorIndex === -1) return <Text>{line || " "}</Text>;
  const before = line.slice(0, cursorIndex);
  const after = line.slice(cursorIndex + marker.length);
  return (
    <Text>
      {before}
      <Text inverse={active}> </Text>
      {after}
    </Text>
  );
}

function wrapRawInput(value: string, width: number): string[] {
  const output: string[] = [];
  for (const physicalLine of value.split(/\r?\n/)) {
    if (physicalLine.length === 0) {
      output.push("");
      continue;
    }
    let remaining = physicalLine;
    while (remaining.length > width) {
      output.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    output.push(remaining);
  }
  return output.length ? output : [""];
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const left = Math.ceil((maxLength - 1) / 2);
  const right = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function SelectionHint({
  selected,
  children,
}: {
  selected: boolean;
  children: React.ReactNode;
}) {
  return (
    <Text color={selected ? "black" : "gray"} backgroundColor={selected ? COLORS.accent : undefined}>
      {children}
    </Text>
  );
}
