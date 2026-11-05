import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { AppModel } from '../hooks/use-app-model';

export function TaskConfirmation({ model }: { model: AppModel }) {
  const { confirm, busy, setConfirm, t, online, taskAction, criteria } = model;
  return (
    <Dialog
      open={confirm !== null}
      onOpenChange={open => {
        if (!open && !busy) setConfirm(null);
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{confirm?.title}</DialogTitle>
          <DialogDescription>{confirm?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
            {t('Cancel', '취소')}
          </Button>
          <Button
            disabled={busy || !online}
            onClick={() => {
              const current = confirm;
              if (current) {
                setConfirm(null);
                void taskAction(
                  current.action,
                  current.action === 'finish-success' ? { criteria } : current.action === 'release' ? { external_session_stopped: true } : {}
                );
              }
            }}
          >
            {t('Confirm', '확정')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
