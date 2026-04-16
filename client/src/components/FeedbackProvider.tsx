import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { toast as sonnerToast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type ToastTone = 'success' | 'error' | 'info';
type ConfirmTone = 'primary' | 'danger';

interface ToastInput {
  tone?: ToastTone;
  title: string;
  description?: string;
  durationMs?: number;
}

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  tone?: ConfirmTone;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (accepted: boolean) => void;
}

interface FeedbackContextValue {
  notify: (input: ToastInput) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

function ConfirmDialogInner({
  dialog,
  onClose,
}: {
  dialog: ConfirmState | null;
  onClose: (accepted: boolean) => void;
}) {
  return (
    <AlertDialog open={!!dialog} onOpenChange={(open) => { if (!open) onClose(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{dialog?.title}</AlertDialogTitle>
          {dialog?.description && (
            <AlertDialogDescription>{dialog.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onClose(false)}>
            {dialog?.cancelText ?? '取消'}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onClose(true)}
            className={cn(
              dialog?.tone === 'danger' && buttonVariants({ variant: 'destructive' }),
            )}
          >
            {dialog?.confirmText ?? '确认'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<ConfirmState | null>(null);

  const notify = useCallback((input: ToastInput) => {
    const duration = input.durationMs ?? 3200;
    const tone = input.tone ?? 'info';

    if (tone === 'success') {
      sonnerToast.success(input.title, { description: input.description, duration });
    } else if (tone === 'error') {
      sonnerToast.error(input.title, { description: input.description, duration });
    } else {
      sonnerToast.info(input.title, { description: input.description, duration });
    }
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setDialog((current) => {
        current?.resolve(false);
        return { ...options, resolve };
      });
    });
  }, []);

  const handleCloseDialog = useCallback((accepted: boolean) => {
    setDialog((current) => {
      current?.resolve(accepted);
      return null;
    });
  }, []);

  const value = useMemo<FeedbackContextValue>(() => ({ notify, confirm }), [confirm, notify]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <ConfirmDialogInner dialog={dialog} onClose={handleCloseDialog} />
    </FeedbackContext.Provider>
  );
}

export function useFeedback() {
  const value = useContext(FeedbackContext);
  if (!value) {
    throw new Error('useFeedback must be used within FeedbackProvider');
  }
  return value;
}
