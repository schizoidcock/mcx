const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&#x27;': "'", '&#x2F;': '/', '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|#x27|#x2F|nbsp);/g, m => ENTITIES[m] || m);
}

/** Remove HTML tags, decode entities, normalize whitespace */
export function isHtml(content: string): boolean {
  return /<(!DOCTYPE|html|head|body|div|p|span|a|img|table|ul|ol|li|h[1-6]|script|style|meta|link)\b/i.test(content);
}

export function htmlToMarkdown(html: string): string {
  let md = html;

  // Remove script, style, head
  md = md.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Convert headers
  md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
    return '\n' + '#'.repeat(Number(level)) + ' ' + content.trim() + '\n';
  });

  // Convert paragraphs
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');

  // Convert line breaks
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // Convert links
  md = md.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Convert bold
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');

  // Convert italic
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');

  // Convert code blocks
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');

  // Convert inline code
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // Convert lists
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<\/?[uo]l[^>]*>/gi, '\n');

  // Convert blockquotes
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
    return content.split('\n').map((line: string) => '> ' + line).join('\n');
  });

  // Remove remaining HTML tags
  md = md.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  md = decodeEntities(md);

  // Remove empty anchor links [](#anchor-name)
  md = md.replace(/\[\s*\]\([^)]*\)/g, '');
  
  // Normalize whitespace: collapse newlines with spaces between them
  md = md.replace(/(\n\s*){2,}/g, '\n\n');
  md = md.replace(/[ \t]+/g, ' ');
  md = md.trim();

  return md;
}

/** Extract main content from HTML page */
export function extractMainContent(html: string): string {
  // Try to find main content area
  const mainMatch = html.match(/<(main|article)[^>]*>([\s\S]*?)<\/\1>/i);
  if (mainMatch) {
    return htmlToMarkdown(mainMatch[2]);
  }

  // Fallback to body
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    return htmlToMarkdown(bodyMatch[1]);
  }

  return htmlToMarkdown(html);
}
