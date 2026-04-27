/**
 * Error Tips - Actionable guidance for common errors
 * ONE source of truth for error messages with tips
 */

export const errorTips = {
  reload: (path: string, storeAs: string) =>
    `💡 Reload file again: mcx_file({ path: "${path}", storeAs: "${storeAs}" })`,

  loadFirst: (storeAs: string) =>
    `💡 Load first: mcx_file({ path: "/abs/path/file", storeAs: "${storeAs}" })`,

  useExisting: (varName: string) =>
    `💡 Use: mcx_file({ storeAs: "${varName}", code: "..." }) to read the content.`,

  alreadyLoaded: (existingVar: string, correctedCode: string) =>
    `Already loaded as ${existingVar}. Use: mcx_file({ storeAs: "${existingVar}", code: "${correctedCode}" })`,

  validParams: (params: string[]) =>
    `💡 Valid: ${params.join(", ")}`,

  fullFileFillsContext: () =>
    `💡 Returning full file fills context. Use grep/lines instead.`,

  writeRequiresString: (varName: string) =>
    `💡 ${varName}: write requires code to return string, e.g.: $var.raw.replace('old', 'new')`,

  writeRequiresExpression: () =>
    `💡 write requires JS expression returning string, e.g.: $var.raw.replace('old', 'new')`,

  noSpecLoaded: () =>
    `💡 No spec loaded. Use mcx_doctor() to check config.`,

  grepNeedsDirectory: (path: string) =>
    `💡 Path must be a DIRECTORY, not a file: "${path}". Use mcx_file with grep() for single files.`,

  noSearchTerm: () =>
    `💡 No search term found. Example: mcx_grep({ query: '*.ts useState' })`,

  missingGrepPath: (searchTerm: string) =>
    `💡 Missing path. Example: mcx_grep({ query: "${searchTerm}", path: "/project/src" })`,

  // fetch.ts
  invalidUrl: (url: string) =>
    `💡 Invalid URL: "${url}". Must start with http:// or https://`,
};
