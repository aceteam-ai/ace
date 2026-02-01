import chalk from "chalk";

export function success(message: string): void {
  console.log(chalk.green("✓") + " " + message);
}

export function error(message: string): void {
  console.error(chalk.red("✗") + " " + message);
}

export function info(message: string): void {
  console.log(chalk.blue("ℹ") + " " + message);
}

export function warn(message: string): void {
  console.log(chalk.yellow("!") + " " + message);
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function printTable(
  headers: string[],
  rows: string[][]
): void {
  // Calculate column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] || "").length))
  );

  // Print header
  const headerLine = headers
    .map((h, i) => h.padEnd(widths[i]))
    .join("  ");
  console.log(chalk.bold(headerLine));
  console.log(widths.map((w) => "─".repeat(w)).join("──"));

  // Print rows
  for (const row of rows) {
    console.log(
      row.map((cell, i) => cell.padEnd(widths[i])).join("  ")
    );
  }
}
