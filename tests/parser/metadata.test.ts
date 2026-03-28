import { describe, it, expect } from 'vitest';
import { extractMetadata } from '../../src/parser/metadata';

describe('extractMetadata', () => {
  it('should extract file paths', () => {
    const content = 'Editing src/app.ts and tests/app.test.ts for the feature';
    const meta = extractMetadata(content);
    expect(meta.filePaths).toContain('src/app.ts');
    expect(meta.filePaths).toContain('tests/app.test.ts');
  });

  it('should deduplicate file paths', () => {
    const content = 'Read src/app.ts then modify src/app.ts again';
    const meta = extractMetadata(content);
    expect(meta.filePaths.filter((p) => p === 'src/app.ts').length).toBe(1);
  });

  it('should extract tool names from [Tool: Name] patterns', () => {
    const content = '[Tool: Bash] ls\n[Tool: Write] src/file.ts\n[Tool: Bash] cat file';
    const meta = extractMetadata(content);
    expect(meta.toolNames).toContain('Bash');
    expect(meta.toolNames).toContain('Write');
    expect(meta.toolNames.length).toBe(2); // Bash deduplicated
  });

  it('should extract error messages', () => {
    const content = [
      'Running tests...',
      'Error: Cannot find module',
      'All good here',
      'TypeError: undefined is not a function',
      '処理が失敗しました',
    ].join('\n');
    const meta = extractMetadata(content);
    expect(meta.errorMessages.length).toBe(3);
    expect(meta.errorMessages[0]).toContain('Cannot find module');
    expect(meta.errorMessages[1]).toContain('TypeError');
    expect(meta.errorMessages[2]).toContain('失敗');
  });

  it('should return empty arrays for content with no matches', () => {
    const meta = extractMetadata('Just some plain text here');
    expect(meta.filePaths).toEqual([]);
    expect(meta.toolNames).toEqual([]);
    expect(meta.errorMessages).toEqual([]);
  });

  it('should handle case-insensitive error matching', () => {
    const content = 'error: something\nERROR: something else\nException caught';
    const meta = extractMetadata(content);
    expect(meta.errorMessages.length).toBe(3);
  });
});
