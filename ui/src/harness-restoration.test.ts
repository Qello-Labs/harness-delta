import { expect, test } from 'vitest';
import { groupRestorationFiles, restorationCopy, restorationResult, unstageCommand } from './harness-restoration';

test('preview files are grouped by the action the user will see', () => {
 expect(groupRestorationFiles([
  { path: 'AGENTS.md', action: 'restore' }, { path: 'docs/new.md', action: 'delete' },
  { path: 'src/AGENTS.md', action: 'unchanged' }, { path: 'edited.md', action: 'conflict' },
 ])).toEqual({ restore: ['AGENTS.md'], delete: ['docs/new.md'], unchanged: ['src/AGENTS.md'], conflict: ['edited.md'] });
});

test('group labels include counts in both languages', () => {
 expect(restorationCopy('ko').groups.delete(2)).toBe('삭제 (2) — 하네스가 새로 만든 파일입니다.');
 expect(restorationCopy('en').groups.restore(1)).toBe('Restore earlier content (1): files that the harness changed.');
 expect(restorationCopy('ko').conflictTitle(3)).toBe('직접 고친 파일이 있어 되돌릴 수 없습니다 (3).');
});

test('a clean staged check never claims the pull request is safe', () => {
 const clean = restorationResult({ clean: true, files: [] }, 'ko');
 expect(clean).toEqual({ tone: 'success', message: '하네스를 되돌렸습니다. 커밋 대기 목록에 하네스 변경분이 없습니다.', paths: [] });
 expect(clean.message).not.toContain('PR');
});

test('staged harness files and failed index reads are warnings with next steps', () => {
 expect(restorationResult({ clean: false, files: [{ path: 'AGENTS.md', reason: 'application_change_staged' }] }, 'en'))
  .toMatchObject({ tone: 'warning', paths: ['AGENTS.md'] });
 expect(restorationResult({ clean: null, error: 'local_operation_failed' }, 'ko').message).toContain('git status');
});

test('the unstage command quotes each path for the shell', () => {
 expect(unstageCommand(['AGENTS.md', "it's.md"])).toBe("git restore --staged -- 'AGENTS.md' 'it'\\''s.md'");
});
