import type { Chunk } from './types.js';
import { MAX_CHUNK_BYTES } from '../tools/constants.js';

import { createDebugger } from "../utils/debug.js";

const debug = createDebugger("chunker");

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
 * Chunk JSON content by key paths.
 * Each top-level key becomes a chunk, nested objects get path titles.
 */
export function chunkJSON(text: string, maxDepth = 3): Chunk[] {
  const chunks: Chunk[] = [];
  
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Not valid JSON, fall back to plaintext
    return chunkPlainText(text);
  }

  function traverse(obj: unknown, path: string[], depth: number) {
    if (depth > maxDepth) {
      // Max depth reached, stringify remainder
      const title = path.length > 0 ? path.join('.') : 'root';
      chunks.push({
        title,
        content: JSON.stringify(obj, null, 2),
      });
      return;
    }

    if (Array.isArray(obj)) {
      // For arrays, chunk by reasonable sizes
      if (obj.length <= 10) {
        const title = path.length > 0 ? path.join('.') : 'root';
        chunks.push({
          title: `${title}[${obj.length} items]`,
          content: JSON.stringify(obj, null, 2),
        });
      } else {
        // Large array: chunk in groups of 10
        for (let i = 0; i < obj.length; i += 10) {
          const slice = obj.slice(i, Math.min(i + 10, obj.length));
          const title = path.length > 0 
            ? `${path.join('.')}[${i}-${Math.min(i + 9, obj.length - 1)}]`
            : `[${i}-${Math.min(i + 9, obj.length - 1)}]`;
          chunks.push({
            title,
            content: JSON.stringify(slice, null, 2),
          });
        }
      }
    } else if (obj && typeof obj === 'object') {
      const keys = Object.keys(obj as Record<string, unknown>);
      
      // Small objects: single chunk
      const serialized = JSON.stringify(obj, null, 2);
      if (keys.length <= 5 || serialized.length < 1000) {
        const title = path.length > 0 ? path.join('.') : 'root';
        chunks.push({
          title,
          content: serialized,
        });
        return;
      }

      // Large objects: recurse into each key
      for (const key of keys) {
        traverse((obj as Record<string, unknown>)[key], [...path, key], depth + 1);
      }
    } else {
      // Primitive value
      const title = path.length > 0 ? path.join('.') : 'value';
      chunks.push({
        title,
        content: String(obj),
      });
    }
  }

  traverse(data, [], 0);
  return chunks.length > 0 ? chunks : chunkPlainText(text);
}

/**
 * Auto-detect content type and chunk accordingly.
 */
export function chunkContent(
  text: string,
  contentType?: 'markdown' | 'plaintext' | 'json',
  linesPerChunk = 20,
  maxChunkBytes = MAX_CHUNK_BYTES
): Chunk[] {
  let chunks: Chunk[];
  
  if (contentType === 'markdown') {
    chunks = chunkMarkdown(text);
  } else if (contentType === 'plaintext') {
    chunks = chunkPlainText(text, linesPerChunk);
  } else if (contentType === 'json') {
    chunks = chunkJSON(text);
  } else if (/^#{1,4}\s+.+$/m.test(text)) {
    chunks = chunkMarkdown(text);
  } else {
    chunks = chunkPlainText(text, linesPerChunk);
  }
  
  return enforceChunkLimits(chunks, maxChunkBytes);
}

/**
 * Find best split point within maxBytes using delimiter hierarchy.
 * Priority: paragraph > line > sentence > word
 */
function findSplitPoint(text: string, maxBytes: number): number {
  const NL = String.fromCharCode(10);
  const delimiters = [NL + NL, NL, '. ', ' '];
  
  for (const delim of delimiters) {
    const regex = new RegExp(delim, 'g');
    let lastGoodPos = -1;
    let match: RegExpExecArray | null;
    
    while ((match = regex.exec(text)) !== null) {
      const pos = match.index + match[0].length;
      if (Buffer.byteLength(text.slice(0, pos)) > maxBytes) break;
      lastGoodPos = pos;
    }
    
    if (lastGoodPos > 0) return lastGoodPos;
  }
  
  return maxBytes;
}

/**
 * Split oversized chunks into smaller pieces.
 */
function splitOversized(chunk: Chunk, maxBytes: number): Chunk[] {
  const bytes = Buffer.byteLength(chunk.content);
  if (bytes <= maxBytes) return [chunk];
  
  const result: Chunk[] = [];
  let remaining = chunk.content;
  let partNum = 1;
  
  while (Buffer.byteLength(remaining) > maxBytes) {
    const splitAt = findSplitPoint(remaining, maxBytes);
    const piece = remaining.slice(0, splitAt).trim();
    remaining = remaining.slice(splitAt).trim();
    
    if (piece) {
      result.push({
        title: `${chunk.title} (${partNum++})`,
        content: piece,
        hasCode: chunk.hasCode,
      });
    }
  }
  
  if (remaining) {
    result.push({
      title: result.length > 0 ? `${chunk.title} (${partNum})` : chunk.title,
      content: remaining,
      hasCode: chunk.hasCode,
    });
  }
  
  return result;
}

/**
 * Apply size limits to all chunks.
 */
export function enforceChunkLimits(chunks: Chunk[], maxBytes = MAX_CHUNK_BYTES): Chunk[] {
  return chunks.flatMap(chunk => splitOversized(chunk, maxBytes));
}
