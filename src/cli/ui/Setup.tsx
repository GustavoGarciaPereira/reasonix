import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import React, { useState } from "react";
import { defaultConfigPath, isPlausibleKey, redactKey, saveApiKey } from "../../config.js";

export interface SetupProps {
  onReady: (apiKey: string) => void;
}

export function Setup({ onReady }: SetupProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { exit } = useApp();

  const handleSubmit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "/exit" || trimmed === "/quit") {
      exit();
      return;
    }
    if (!isPlausibleKey(trimmed)) {
      setError("Doesn't look like a DeepSeek key. They start with 'sk-' and are 30+ chars.");
      setValue("");
      return;
    }
    try {
      saveApiKey(trimmed);
    } catch (err) {
      setError(`Could not save key: ${(err as Error).message}`);
      return;
    }
    onReady(trimmed);
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Welcome to Reasonix.
      </Text>
      <Box marginTop={1}>
        <Text>Paste your DeepSeek API key to get started.</Text>
      </Box>
      <Text dimColor>Get one (free credit on signup): https://platform.deepseek.com/api_keys</Text>
      <Text dimColor>Saved locally to {defaultConfigPath()}</Text>
      <Box marginTop={1}>
        <Text bold color="cyan">
          {"key › "}
        </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          mask="•"
          placeholder="sk-..."
        />
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : value ? (
        <Box marginTop={1}>
          <Text dimColor>preview: {redactKey(value)}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>(Type /exit to abort.)</Text>
      </Box>
    </Box>
  );
}
