import type { Locale } from './types';

export type RestorationAction = 'restore' | 'delete' | 'unchanged' | 'conflict';
export interface RestorationPreview { digest: string; files: { path: string; action: RestorationAction }[] }
export type StagedCheck = { clean: true; files: [] } | { clean: false; files: { path: string; reason: string }[] } | { clean: null; error: string };

export function groupRestorationFiles(files: RestorationPreview['files']): Record<RestorationAction, string[]> {
 const groups: Record<RestorationAction, string[]> = { restore: [], delete: [], unchanged: [], conflict: [] };
 for (const file of files) groups[file.action].push(file.path);
 return groups;
}

export function restorationCopy(locale: Locale) {
 const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
 return {
  outcomeNotice: t('Measurement has ended. The harness files used for measurement are still in your project. Remove the harness before you open a pull request.',
   '측정이 끝났습니다. 측정에 쓴 하네스 파일은 아직 프로젝트에 남아 있습니다. PR을 올리기 전에 하네스를 되돌리세요.'),
  cardTitle: t('Remove the harness from your project', '프로젝트에서 하네스 되돌리기'),
  cardBody: t('Your measurement results stay. Files that the harness changed return to their earlier content. Files that the harness created are deleted.',
   '측정 결과는 그대로 남습니다. 하네스가 고친 파일은 적용 전 내용으로 돌아가고, 하네스가 새로 만든 파일은 삭제됩니다.'),
  cardButton: t('Remove harness…', '하네스 되돌리기…'),
  dialogTitle: t('Remove the harness?', '하네스를 되돌릴까요?'),
  dialogDescription: t('These files return to their state before the harness was applied. After this, you must apply the harness again to measure this task again.',
   '아래 파일을 하네스 적용 전 상태로 되돌립니다. 되돌린 뒤에는 하네스를 다시 적용해야 이 작업을 다시 측정할 수 있습니다.'),
  loading: t('Checking the files…', '파일을 확인하는 중…'),
  groups: {
   restore: (n: number) => t(`Restore earlier content (${n}): files that the harness changed.`, `원래 내용으로 되돌림 (${n}) — 하네스가 고친 파일입니다.`),
   delete: (n: number) => t(`Delete (${n}): files that the harness created.`, `삭제 (${n}) — 하네스가 새로 만든 파일입니다.`),
   unchanged: (n: number) => t(`No change (${n}): already in their earlier state.`, `변경 없음 (${n}) — 이미 원래 상태입니다.`),
  },
  conflictTitle: (n: number) => t(`Some files changed after the harness was applied (${n}).`, `직접 고친 파일이 있어 되돌릴 수 없습니다 (${n}).`),
  conflictBody: t('No file was changed, so your edits are safe. Resolve these files, then try again.',
   '하네스 적용 뒤에 이 파일들이 수정됐습니다. 수정 내용을 잃지 않도록 아무 파일도 바꾸지 않았습니다. 수정 내용을 정리한 뒤 다시 시도하세요.'),
  checkbox: t('I stopped the AI session in my terminal or IDE.', '터미널이나 IDE에서 AI 세션을 직접 종료했습니다.'),
  checkboxHelp: t('A running AI can change the restored files again. Harness Delta does not stop the AI for you.',
   '실행 중인 AI는 되돌린 파일을 다시 고칠 수 있습니다. Harness Delta는 AI를 대신 종료하지 않습니다.'),
  indexNote: t('Files that you already added with git add stay staged.', '이미 git add 한 파일은 커밋 대기(staged) 목록에 그대로 남습니다.'),
  cancel: t('Cancel', '취소'),
  confirm: t('Remove', '되돌리기'),
  retry: t('Check again', '다시 확인'),
  previewChanged: t('Files changed while you reviewed the list. Review the new list.', '목록을 확인하는 동안 파일이 바뀌었습니다. 새 목록을 불러왔으니 다시 확인하세요.'),
  previewFailed: t('The file list could not be loaded. Try again.', '파일 목록을 불러오지 못했습니다. 다시 시도하세요.'),
 };
}

export function restorationResult(staged: StagedCheck, locale: Locale): { tone: 'success' | 'warning'; message: string; paths: string[] } {
 const t = (en: string, ko: string) => locale === 'ko' ? ko : en;
 if (staged.clean === true) return { tone: 'success', message: t('The harness is removed. No harness edits are staged.', '하네스를 되돌렸습니다. 커밋 대기 목록에 하네스 변경분이 없습니다.'), paths: [] };
 if (staged.clean === null) return { tone: 'warning', message: t('The harness is removed, but the staged files could not be checked. Run git status in a terminal.',
  '하네스를 되돌렸지만 커밋 대기 목록은 확인하지 못했습니다. 터미널에서 git status로 확인하세요.'), paths: [] };
 const paths = staged.files.map(file => file.path);
 return { tone: 'warning', paths, message: t('The harness is removed, but harness files are still staged. Run git restore --staged with these paths in a terminal.',
  '하네스를 되돌렸습니다. 아직 커밋 대기 목록에 하네스 파일이 있습니다. 터미널에서 아래 파일마다 git restore --staged를 실행하세요.') };
}

export function unstageCommand(paths: string[]): string {
 return `git restore --staged -- ${paths.map(path => `'${path.replaceAll("'", "'\\''")}'`).join(' ')}`;
}
