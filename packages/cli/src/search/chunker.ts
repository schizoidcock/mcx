import type { Chunk } from './types.js';

const HEADING_REGEX = /^(#{1,4})\s+(.+)$/;
const HORIZONTAL_RULE = /^---+$/;
const CODE_FENCE = /^```/;

/**
 * Chunk markdown content by headings.
 * Preserves code blocks intact (never split mid-code).
 */
export function chunkMarkdown(text: string): Chunk[] {
  const lines = text.split('\n');
  const chunks: Chunk[] = [];

  // Heading stack for hierarchical titles: ["Auth", "Login"] -> "Auth > Login"
  const headingStack: { level: number; text: string }[] = [];
  let currentContent: string[] = [];
  let inCodeBlock = false;
  let hasCode = false;

  function flushChunk() {
    if (currentContent.length === 0) return;

    const title = headingStack.length > 0
      ? headingStack.map(h => h.text).join(' > ')
      : 'Document';

    chunks.push({
      title,
      content: currentContent.join('\n').trim(),
      hasCode,
    });

    currentContent = [];
    hasCode = false;
  }

  for (const line of lines) {
    // Track code blocks
    if (CODE_FENCE.test(line)) {
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) hasCode = true;
      currentContent.push(line);
      continue;
    }

    // Don't process headings/rules inside code blocks
    if (inCodeBlock) {
      currentContent.push(line);
      continue;
    }

    // Horizontal rule separates chunks
    if (HORIZONTAL_RULE.test(line.trim())) {
      flushChunk();
      continue;
    }

    // Heading starts new chunk
    const headingMatch = line.match(HEADING_REGEX);
    if (headingMatch) {
      flushChunk();

      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();

      // Pop stack to current level
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }

      headingStack.push({ level, text: headingText });
      currentContent.push(line);
      continue;
    }

    currentContent.push(line);
  }

  flushChunk();
  return chunks;
}

/**
 * Chunk plain text content.
 *
 * Strategy 1: If text has natural sections (blank lines), use those.
 * Strategy 2: Otherwise, fixed-size chunks with overlap.
 */
export function chunkPlainText(text: string, linesPerChunk = 20): Chunk[] {
  const chunks: Chunk[] = [];

  // Strategy 1: Blank line splitting
  const sections = text.split(/\n\s*\n/);
  if (sections.length >= 3 && sections.length <= 200) {
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i].trim();
      if (!section) continue;

      const firstLine = section.split('\n')[0].slice(0, 80);
      chunks.push({
        title: firstLine || `Section ${i + 1}`,
        content: section,
      });
    }
    return chunks;
  }

  // Strategy 2: Fixed-size with overlap
  const lines = text.split('\n');
  const overlap = 2;
  const step = Math.max(1, linesPerChunk - overlap);

  for (let i = 0; i < lines.length; i += step) {
    const chunkLines = lines.slice(i, i + linesPerChunk);
    const content = chunkLines.join('\n').trim();
    if (!content) continue;

    const firstLine = chunkLines[0]?.trim().slice(0, 80) || '';
    chunks.push({
      title: firstLine || `Lines ${i + 1}-${i + chunkLines.length}`,
      content,
    });
  }

  return chunks;
}

/**
 * Auto-detect content type and chunk accordingly.
 */
export function chunkContent(
  text: string,
  contentType?: 'markdown' | 'plaintext',
  linesPerChunk = 20
): Chunk[] {
  // Use explicit content type if provided
  if (contentType === 'markdown') {
    return chunkMarkdown(text);
  }
  if (contentType === 'plaintext') {
    return chunkPlainText(text, linesPerChunk);
  }

  // Auto-detect: markdown if it has headings (multiline regex avoids full split)
  if (/^#{1,4}\s+.+$/m.test(text)) {
    return chunkMarkdown(text);
  }

  return chunkPlainText(text, linesPerChunk);
}
