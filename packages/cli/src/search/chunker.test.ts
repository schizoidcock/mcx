import { describe, test, expect } from 'bun:test';
import { chunkMarkdown, chunkPlainText, chunkContent } from './chunker';

describe('chunkMarkdown', () => {
  test('creates chunks from headings', () => {
    const text = `# Header 1
Content under header 1

## Header 2
Content under header 2`;

    const chunks = chunkMarkdown(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].title).toBe('Header 1');
    expect(chunks[1].title).toBe('Header 1 > Header 2');
  });

  test('preserves hierarchical titles', () => {
    const text = `# Top
## Mid
### Low
Content`;

    const chunks = chunkMarkdown(text);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.title).toBe('Top > Mid > Low');
  });

  test('keeps code blocks intact', () => {
    const text = `# Code Example
\`\`\`javascript
function hello() {
  console.log("hello");
}
\`\`\``;

    const chunks = chunkMarkdown(text);
    expect(chunks[0].hasCode).toBe(true);
    expect(chunks[0].content).toContain('function hello()');
  });

  test('does not split inside code blocks', () => {
    const text = `# Example
\`\`\`
# This is not a heading
## Neither is this
\`\`\``;

    const chunks = chunkMarkdown(text);
    // Should be single chunk since "headings" are inside code block
    expect(chunks.length).toBe(1);
  });

  test('splits on horizontal rules', () => {
    const text = `# Section 1
Content 1

---

# Section 2
Content 2`;

    const chunks = chunkMarkdown(text);
    // Horizontal rule creates a break, then each heading creates a new chunk
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test('handles document without headings', () => {
    const text = 'Just some plain text without any headings';
    const chunks = chunkMarkdown(text);

    expect(chunks.length).toBe(1);
    expect(chunks[0].title).toBe('Document');
  });
});

describe('chunkPlainText', () => {
  test('splits by blank lines when possible', () => {
    const text = `Paragraph 1 content here.

Paragraph 2 content here.

Paragraph 3 content here.`;

    const chunks = chunkPlainText(text);
    expect(chunks.length).toBe(3);
  });

  test('uses fixed-size chunks for long text without sections', () => {
    // Create text without natural sections (200+ lines)
    const lines = Array.from({ length: 250 }, (_, i) => `Line ${i + 1}`);
    const text = lines.join('\n');

    const chunks = chunkPlainText(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('creates multiple chunks for long text', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
    const text = lines.join('\n');

    const chunks = chunkPlainText(text, 20);

    // Should create multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should start with Line 1
    expect(chunks[0].content).toContain('Line 1');
    // Last chunk should contain the final lines
    expect(chunks[chunks.length - 1].content).toContain('Line 50');
  });

  test('uses first line as title', () => {
    const text = `First line is the title
Second line
Third line`;

    const chunks = chunkPlainText(text);
    expect(chunks[0].title).toContain('First line');
  });
});

describe('chunkContent', () => {
  test('auto-detects markdown', () => {
    const markdown = `# This is Markdown
With content`;

    const chunks = chunkContent(markdown);
    expect(chunks[0].title).toBe('This is Markdown');
  });

  test('auto-detects plain text', () => {
    const plainText = 'This is plain text without any markdown headings';
    const chunks = chunkContent(plainText);

    expect(chunks.length).toBeGreaterThan(0);
  });

  test('respects explicit contentType markdown', () => {
    const text = '# Heading\nContent';
    const chunks = chunkContent(text, 'markdown');

    expect(chunks[0].title).toBe('Heading');
  });

  test('respects explicit contentType plaintext', () => {
    const text = '# Not a heading\nJust text';
    const chunks = chunkContent(text, 'plaintext');

    // Should not parse # as heading
    expect(chunks[0].title).not.toBe('Not a heading');
  });
});
