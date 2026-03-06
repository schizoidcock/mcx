/**
 * Resolves $ref pointers in OpenAPI/JSON Schema objects.
 * Handles circular references by returning { $circular: ref } marker.
 */
export function resolveRefs(
  obj: unknown,
  root: Record<string, unknown>,
  seen = new Set<string>()
): unknown {
  if (typeof obj !== 'object' || obj === null) return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveRefs(item, root, seen));
  }

  const record = obj as Record<string, unknown>;

  if ('$ref' in record && typeof record.$ref === 'string') {
    const ref = record.$ref;

    // Circular reference detection
    if (seen.has(ref)) {
      return { $circular: ref };
    }
    seen.add(ref);

    // Resolve the reference
    const resolved = resolveRefPath(ref, root);
    if (resolved === undefined) {
      return { $unresolved: ref };
    }

    return resolveRefs(resolved, root, seen);
  }

  // Recursively resolve all properties (reuse same seen set - only $refs matter)
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = resolveRefs(value, root, seen);
  }
  return result;
}

/**
 * Resolves a JSON pointer path like "#/components/schemas/User"
 */
function resolveRefPath(
  ref: string,
  root: Record<string, unknown>
): unknown {
  if (!ref.startsWith('#/')) {
    return undefined; // External refs not supported
  }

  const parts = ref.slice(2).split('/').map(decodeJsonPointer);
  let current: unknown = root;

  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Decodes JSON Pointer escape sequences (~0 = ~, ~1 = /)
 */
function decodeJsonPointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
