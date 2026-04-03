/**
 * Formata milissegundos em uma string legível como "2h 35m 12s"
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours % 24 > 0) parts.push(`${hours % 24}h`);
  if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
  if (seconds % 60 > 0 || parts.length === 0) parts.push(`${seconds % 60}s`);

  return parts.join(" ");
}

/**
 * Retorna uma barra de progresso visual baseada em porcentagem
 */
export function progressBar(ratio: number, width: number = 20): string {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return "[" + "█".repeat(filled) + "░".repeat(empty) + "]";
}

/**
 * Formata uma tabela simples para o console
 */
export function formatTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => {
    const maxRow = rows.reduce((max, row) => Math.max(max, (row[i] || "").length), 0);
    return Math.max(h.length, maxRow);
  });

  const sep = colWidths.map(w => "─".repeat(w + 2)).join("┼");
  const headerLine = headers.map((h, i) => ` ${h.padEnd(colWidths[i])} `).join("│");
  const dataLines = rows.map(row =>
    row.map((cell, i) => ` ${(cell || "").padEnd(colWidths[i])} `).join("│")
  );

  return [
    "┌" + colWidths.map(w => "─".repeat(w + 2)).join("┬") + "┐",
    "│" + headerLine + "│",
    "├" + sep + "┤",
    ...dataLines.map(l => "│" + l + "│"),
    "└" + colWidths.map(w => "─".repeat(w + 2)).join("┴") + "┘",
  ].join("\n");
}
