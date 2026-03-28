export interface ExtractedMetadata {
  filePaths: string[];
  toolNames: string[];
  errorMessages: string[];
}

const FILE_PATH_RE = /[\w./-]+\.\w{1,10}/g;
const TOOL_NAME_RE = /\[Tool: (\w+)\]/g;
const ERROR_RE = /error|失敗|exception/i;

export function extractMetadata(content: string): ExtractedMetadata {
  const filePaths = [...new Set(Array.from(content.matchAll(FILE_PATH_RE), (m) => m[0]))];

  const toolNames = [...new Set(Array.from(content.matchAll(TOOL_NAME_RE), (m) => m[1]))];

  const errorMessages = content
    .split('\n')
    .filter((line) => ERROR_RE.test(line))
    .map((line) => line.trim());

  return { filePaths, toolNames, errorMessages };
}
