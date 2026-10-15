import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Locale, Task } from './types';
import { groupRestorationFiles, restorationCopy, restorationResult, unstageCommand, type RestorationPreview, type StagedCheck } from './harness-restoration';

export type RestoreOutcome = { staged: StagedCheck } | { error: string };

export function HarnessRestoration({ task, locale, busy, onRestore, describeError }: { task: Task; locale: Locale; busy: boolean; onRestore: (body: { preview_digest: string; external_session_stopped: true }) => Promise<RestoreOutcome>; describeError: (code: string) => string }) {
 const copy = restorationCopy(locale);
 const [open, setOpen] = useState(false);
 const [preview, setPreview] = useState<RestorationPreview | null>(null);
 const [stopped, setStopped] = useState(false);
 const [notice, setNotice] = useState<string | null>(null);
 const [staged, setStaged] = useState<StagedCheck | null>(null);
 const request = useRef(0);
 const restoration = task.application?.restoration;
 const enabled = task.actions.find(action => action.code === 'application-restore')?.enabled === true;

 async function load(message: string | null) {
  // Only the latest request may update the list; an older response must not replace it.
  const current = ++request.current;
  setPreview(null); setNotice(message);
  try {
   const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/application-restoration`, { cache: 'no-store' });
   const value = response.ok ? await response.json() as RestorationPreview : null;
   if (current !== request.current) return;
   if (value) setPreview(value); else setNotice(copy.previewFailed);
  } catch { if (current === request.current) setNotice(copy.previewFailed); }
 }
 async function confirm() {
  if (!preview) return;
  const outcome = await onRestore({ preview_digest: preview.digest, external_session_stopped: true });
  if ('staged' in outcome) { setOpen(false); setStaged(outcome.staged); return; }
  // Both codes mean the shown list is no longer current; never retry with the old digest.
  if (outcome.error === 'application_preview_changed' || outcome.error === 'application_restore_conflict') await load(copy.previewChanged);
  else setNotice(describeError(outcome.error));
 }

 if (staged) {
  const result = restorationResult(staged, locale);
  return <Card><CardHeader><CardTitle>{copy.cardTitle}</CardTitle></CardHeader><CardContent className="space-y-3">
   <p role="status" className={result.tone === 'success' ? 'text-sm' : 'text-sm text-destructive'}>{result.message}</p>
   {result.paths.length > 0 && <><ul className="list-disc pl-5 text-sm break-all">{result.paths.map(path => <li key={path}>{path}</li>)}</ul><pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs"><code>{unstageCommand(result.paths)}</code></pre></>}
  </CardContent></Card>;
 }
 if (restoration !== 'available' && restoration !== 'interrupted') return null;
 const groups = preview ? groupRestorationFiles(preview.files) : null;
 const conflicted = (groups?.conflict.length ?? 0) > 0;
 return <>
  <Card><CardHeader><CardTitle>{copy.cardTitle}</CardTitle><CardDescription>{copy.cardBody}</CardDescription></CardHeader><CardContent>
   <Button variant="outline" disabled={busy || !enabled} onClick={() => { setOpen(true); setStopped(false); void load(null); }}>{copy.cardButton}</Button>
  </CardContent></Card>
  <Dialog open={open} onOpenChange={value => { if (!value && !busy) setOpen(false); }}>
   <DialogContent showCloseButton={false}>
    <DialogHeader><DialogTitle>{copy.dialogTitle}</DialogTitle><DialogDescription>{copy.dialogDescription}</DialogDescription></DialogHeader>
    {notice && <p role="alert" className="text-sm text-destructive">{notice}</p>}
    {!groups ? !notice && <p role="status" className="text-sm text-muted-foreground">{copy.loading}</p> : <div className="max-h-72 space-y-3 overflow-y-auto text-sm">
     {conflicted && <div role="alert" className="rounded-md border border-destructive p-3"><p className="font-medium text-destructive">{copy.conflictTitle(groups.conflict.length)}</p><p className="mt-1">{copy.conflictBody}</p><ul className="mt-2 list-disc pl-5 break-all">{groups.conflict.map(path => <li key={path}>{path}</li>)}</ul></div>}
     {(['restore', 'delete', 'unchanged'] as const).filter(action => groups[action].length > 0).map(action => <div key={action}><p className="font-medium">{copy.groups[action](groups[action].length)}</p><ul className="list-disc pl-5 text-muted-foreground break-all">{groups[action].map(path => <li key={path}>{path}</li>)}</ul></div>)}
    </div>}
    {groups && !conflicted && <div className="space-y-1"><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={stopped} onChange={event => setStopped(event.target.checked)} />{copy.checkbox}</label><p className="pl-6 text-xs text-muted-foreground">{copy.checkboxHelp}</p></div>}
    {groups && !conflicted && <p className="text-xs text-muted-foreground">{copy.indexNote}</p>}
    <DialogFooter>
     <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{copy.cancel}</Button>
     {conflicted || (notice && !groups) ? <Button variant="outline" disabled={busy} onClick={() => { void load(null); }}>{copy.retry}</Button>
      : <Button variant="destructive" disabled={busy || !groups || !stopped} onClick={() => { void confirm(); }}>{copy.confirm}</Button>}
    </DialogFooter>
   </DialogContent>
  </Dialog>
 </>;
}
