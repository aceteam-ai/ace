import React from "react";
import { Box, Text } from "ink";
import { sanitizeTerminalText } from "../terminal.js";

export function MarkdownOutput({ value }: { value: string }): React.JSX.Element {
  const lines = sanitizeTerminalText(value).split("\n");
  let inCode = false;
  return <Box flexDirection="column">
    {lines.map((line, index) => {
      if (line.trim().startsWith("```")) {
        inCode = !inCode;
        return <Text key={index} dimColor>{inCode ? "┌ code" : "└"}</Text>;
      }
      if (inCode) return <Text key={index} color="cyan">  {line}</Text>;
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) return <Text key={index} bold color={heading[1].length === 1 ? "cyan" : undefined}>{heading[2]}</Text>;
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (bullet) return <Text key={index}>  • {bullet[1]}</Text>;
      const numbered = line.match(/^\s*(\d+\.)\s+(.+)$/);
      if (numbered) return <Text key={index}>  {numbered[1]} {numbered[2]}</Text>;
      return <Text key={index}>{line || " "}</Text>;
    })}
  </Box>;
}
