import { createContext, useContext } from 'react';
import type { Locale, TaskAction } from './types';
import type { ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
export const LocaleContext = createContext<Locale>('ko');
export const ActionContext = createContext<{
  action: (code: string) => TaskAction | undefined;
  reason: (code: string) => string;
  busy: boolean;
  online: boolean;
  taskAction: (code: string, body?: unknown) => Promise<void>;
} | null>(null);
export function Help({ label, children }: { label: string; children: ReactNode }) {
  const locale = useContext(LocaleContext);
  const t = (en: string, ko: string) => (locale === 'ko' ? ko : en);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" type="button" aria-label={t(`Help: ${label}`, `${label} 도움말`)}>
          <CircleHelp />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{children}</TooltipContent>
    </Tooltip>
  );
}
export function Field({ id, label, help, children }: { id: string; label: string; help: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <Label htmlFor={id}>{label}</Label>
        <Help label={label}>{help}</Help>
      </div>
      {children}
    </div>
  );
}
export function Action({
  code,
  children,
  variant = 'default'
}: {
  code: string;
  children: ReactNode;
  variant?: 'default' | 'outline' | 'secondary' | 'destructive';
}) {
  const context = useContext(ActionContext);
  if (!context) return null;
  const { action, reason, busy, online, taskAction } = context;
  const option = action(code);
  return (
    <div className="space-y-1">
      <Button
        variant={variant}
        disabled={busy || !online || !option?.enabled}
        onClick={() => {
          void taskAction(code);
        }}
      >
        {children}
      </Button>
      {option && !option.enabled && option.reason && <p className="text-sm text-muted-foreground">{reason(option.reason)}</p>}
    </div>
  );
}
