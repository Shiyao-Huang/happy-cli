function looksLikeAbsolutePathSegment(segment: string): boolean {
  return segment.startsWith('/') || /^[A-Za-z]:[\\/]/.test(segment);
}

/**
 * Detects accidental concatenation of multiple absolute paths into one cwd string.
 * Example invalid input:
 *   "/Users/a/project /Users/a"
 */
export function findWorkspacePathProblem(input: string): string | null {
  const value = input.trim();
  if (!value) {
    return 'Workspace path is empty.';
  }

  if (value.includes('\n')) {
    return 'Workspace path must be a single line.';
  }

  const absoluteSegments = value
    .split(/\s+/g)
    .filter(Boolean)
    .filter(looksLikeAbsolutePathSegment);

  if (absoluteSegments.length > 1) {
    return `Workspace path contains multiple absolute paths: ${absoluteSegments.join(' | ')}`;
  }

  return null;
}
