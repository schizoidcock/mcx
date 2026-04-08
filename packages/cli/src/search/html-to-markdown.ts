/**
 * Convert HTML to Markdown using regex.
 * Based on context-mode's approach - no external dependencies.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&#x27;': "'", '&#x2F;': '/', '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|#x27|#x2F|nbsp);/g, m => ENTITIES[m] || m);
}

export function htmlToMarkdown(html: string): string {
  let md = html;

  // Strip script, style, nav, header, footer tags with content (single pass)
  md = md.replace(/<(script|style|nav|header|footer)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Convert headings to markdown
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '\n#### $1\n');

  // Convert code blocks with language
  md = md.replace(
    /<pre[^>]*><code[^>]*class="[^"]*language-(\w+)"[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    (_, lang, code) => '\n```' + lang + '\n' + decodeEntities(code) + '\n```\n'
  );
  // Convert code blocks without language
  md = md.replace(
    /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    (_, code) => '\n```\n' + decodeEntities(code) + '\n```\n'
  );
  // Convert inline code
  md = md.replace(/<code[^>]*>([^<]*)<\/code>/gi, '`$1`');

  // Convert links (but NOT anchor-only links)
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_, href, text) => {
    const cleanText = text.replace(/<[^>]+>/g, '').trim();
    // Skip anchor-only links - just return the text
    if (href.startsWith('#')) return cleanText;
    // Skip empty links
    if (!cleanText) return '';
    return `[${cleanText}](${href})`;
  });

  // Convert lists
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');

  // Convert paragraphs and line breaks
  md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, '\n$1\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Strip remaining HTML tags
  md = md.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  md = decodeEntities(md);

  // Remove leftover anchor link syntax: [](#...) or [text](#...)
  md = md.replace(/\[([^\]]*)\]\(#[^)]*\)/g, '$1');

  // Remove empty brackets
  md = md.replace(/\[\s*\]/g, '');

  // Clean up whitespace aggressively
  md = md.replace(/^[ \t]+/gm, '');         // Leading spaces (crucial for rendering)
  md = md.replace(/[ \t]+$/gm, '');         // Trailing spaces
  md = md.replace(/\n{3,}/g, '\n\n');       // Max 2 consecutive newlines
  md = md.trim();

  return md;
}

/**
 * Detect if content is HTML.
 */
export function isHtml(content: string): boolean {
  // Check for common HTML indicators
  return /<(!DOCTYPE|html|head|body|div|p|h[1-6]|script|style)/i.test(content);
}
