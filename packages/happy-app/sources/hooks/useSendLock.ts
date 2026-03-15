import * as React from 'react';

// Lightweight session-level send lock. Any component that triggers a send action
// (input bar, permission buttons, question answers) calls notifySendAction().
// SessionViewLoaded subscribes via useOnSendAction() to set localSending = true,
// which is reset when sessionStatus.state changes.
//
// Child components (PermissionFooter, AskUserQuestionView) can read the lock
// state via useSendLocked(sessionId) using useSyncExternalStore for reactivity.

const lockCallbacks = new Map<string, () => void>();
const lockStates = new Map<string, boolean>();
const lockSubscribers = new Map<string, Set<() => void>>();

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

/** Update the lock state for a session (called from SessionView) */
export function setSendLocked(sessionId: string, locked: boolean) {
    if (lockStates.get(sessionId) !== locked) {
        lockStates.set(sessionId, locked);
        lockSubscribers.get(sessionId)?.forEach(cb => cb());
    }
}

/** Read the lock state reactively from any child component */
export function useSendLocked(sessionId: string | undefined): boolean {
    const subscribe = React.useCallback((cb: () => void) => {
        if (!sessionId) return () => {};
        let subs = lockSubscribers.get(sessionId);
        if (!subs) {
            subs = new Set();
            lockSubscribers.set(sessionId, subs);
        }
        subs.add(cb);
        return () => { subs.delete(cb); };
    }, [sessionId]);

    const getSnapshot = React.useCallback(
        () => sessionId ? (lockStates.get(sessionId) ?? false) : false,
        [sessionId]
    );

    return React.useSyncExternalStore(subscribe, getSnapshot);
}
