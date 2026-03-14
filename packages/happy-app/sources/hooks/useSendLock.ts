import * as React from 'react';

// Lightweight session-level send lock. Any component that triggers a send action
// (input bar, permission buttons, question answers) calls notifySendAction().
// SessionViewLoaded subscribes via useOnSendAction() to set localSending = true,
// which is reset when sessionStatus.state changes.

const lockCallbacks = new Map<string, () => void>();

/** Call from any component to signal a send/action for the session */
export function notifySendAction(sessionId: string) {
    lockCallbacks.get(sessionId)?.();
}

/** Register a callback in SessionViewLoaded to receive send action notifications */
export function useOnSendAction(sessionId: string, callback: () => void) {
    React.useEffect(() => {
        lockCallbacks.set(sessionId, callback);
        return () => {
            if (lockCallbacks.get(sessionId) === callback) {
                lockCallbacks.delete(sessionId);
            }
        };
    }, [sessionId, callback]);
}
