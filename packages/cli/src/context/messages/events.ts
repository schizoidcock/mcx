/**
 * Event Tips - Notifications and informational messages
 * ONE source of truth for event notifications
 */

export const tipMessages = {
  staleRead: () => "File was modified since last store. Re-read recommended.",
  staleWrite: () => "Warning: File changed since last read. Verify before editing.",
  noRereadAfterEdit: () => "No need to re-read after edit. Changes confirmed.",
  noRereadAfterWrite: () => "No need to re-read after write. Content confirmed.",
  chainedCommands: () => "Chained commands detected. Consider splitting for better error handling.",
  sameTool3x: () => "Same tool 3x in a row. Check if approach needs adjustment.",
  backToBackEdits: () => "Back-to-back edits. Consider batching changes.",
  editBuildCycle: () => "Edit->build->edit cycle. Batch all edits first, then build once.",
  recursiveGlob: () => 'Recursive ** not supported. Use fuzzy: "*.ts", "dir/", or partial name.',
  pathInPattern: () => "Path in pattern? Use glob param for directory filter.",
  fullOutputRequested: () => "Full output requested. Large results may flood context.",
  truncatedResult: (storedAs: string) => `Truncated. Full result in ${storedAs}`,
};

export const eventTips = {
  autoIndex: (label: string, sizeBytes: number) => {
    const sizeKB = Math.round(sizeBytes / 1024);
    const short = label.includes('/') ? label.split('/').pop() : label.split(':').pop() || label;
    return `📦 Auto-indexed as "${short}" (${sizeKB}KB). Use mcx_search({ queries: [...], source: "${short}" })`;
  },
  
  grepNoMatches: (term: string, filesSearched: number) =>
    `No matches for "${term}" in ${filesSearched} files\n-> Try: broader pattern or different path`,

  linesHunting: (varName: string, count: number) =>
    `Hunting pattern (${count}x). Use grep(${varName}, 'pattern', 5) for context.`,

  linesOverlap: (varName: string) =>
    `💡 Overlapping ranges. Use grep(${varName}, 'pattern', 5) to locate.`,
};
