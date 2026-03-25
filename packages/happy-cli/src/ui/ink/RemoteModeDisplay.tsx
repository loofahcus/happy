import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Text, useStdout, useInput } from 'ink'
import { MessageBuffer, type BufferedMessage } from './messageBuffer'

interface RemoteModeDisplayProps {
    messageBuffer: MessageBuffer
    logPath?: string
    onExit?: () => void
    onSwitchToLocal?: () => void
}

export const RemoteModeDisplay: React.FC<RemoteModeDisplayProps> = ({ messageBuffer, logPath, onExit, onSwitchToLocal }) => {
    const [messages, setMessages] = useState<BufferedMessage[]>([])
    const [confirmationMode, setConfirmationMode] = useState<'exit' | 'switch' | null>(null)
    const [actionInProgress, setActionInProgress] = useState<'exiting' | 'switching' | null>(null)
    const confirmationTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const { stdout } = useStdout()
    const terminalWidth = stdout.columns || 80
    const terminalHeight = stdout.rows || 24

    useEffect(() => {
        setMessages(messageBuffer.getMessages())
        
        const unsubscribe = messageBuffer.onUpdate((newMessages) => {
            setMessages(newMessages)
        })

        return () => {
            unsubscribe()
            if (confirmationTimeoutRef.current) {
                clearTimeout(confirmationTimeoutRef.current)
            }
        }
    }, [messageBuffer])

    const resetConfirmation = useCallback(() => {
        setConfirmationMode(null)
        if (confirmationTimeoutRef.current) {
            clearTimeout(confirmationTimeoutRef.current)
            confirmationTimeoutRef.current = null
        }
    }, [])

    const setConfirmationWithTimeout = useCallback((mode: 'exit' | 'switch') => {
        setConfirmationMode(mode)
        if (confirmationTimeoutRef.current) {
            clearTimeout(confirmationTimeoutRef.current)
        }
        confirmationTimeoutRef.current = setTimeout(() => {
            resetConfirmation()
        }, 15000) // 15 seconds timeout
    }, [resetConfirmation])

    // Use refs for rapidly-changing state read inside useInput.
    // This prevents Ink's useInput from re-subscribing its stdin 'data'
    // listener on every state change. Without refs, the useCallback deps
    // include confirmationMode/actionInProgress, causing handler identity
    // to change -> useInput re-runs its effect (remove old -> add new
    // listener) -> keystrokes arriving in that gap are lost.
    // This is the root cause of the "3 spaces needed" bug.
    const confirmationModeRef = useRef(confirmationMode)
    confirmationModeRef.current = confirmationMode
    const actionInProgressRef = useRef(actionInProgress)
    actionInProgressRef.current = actionInProgress

    // Handler reads state from refs so its identity never changes ->
    // useInput subscribes once and never re-subscribes -> no keystroke gaps.
    // IMPORTANT: Refs must be updated IMMEDIATELY in the handler (before setState)
    // because React state updates are batched and the ref won't reflect the new
    // value until the next render. Without immediate ref updates, rapid keypresses
    // (or even normal-speed presses if Ink's render cycle is slow) will read
    // stale ref values and require extra presses.
    useInput(useCallback(async (input, key) => {
        // Don't process input if action is in progress
        if (actionInProgressRef.current) return
        
        // Handle Ctrl-C
        if (key.ctrl && input === 'c') {
            if (confirmationModeRef.current === 'exit') {
                // Second Ctrl-C, exit
                confirmationModeRef.current = null
                actionInProgressRef.current = 'exiting'
                resetConfirmation()
                setActionInProgress('exiting')
                // Small delay to show the status message
                await new Promise(resolve => setTimeout(resolve, 100))
                onExit?.()
            } else {
                // First Ctrl-C, show confirmation
                confirmationModeRef.current = 'exit'
                setConfirmationWithTimeout('exit')
            }
            return
        }

        // Handle double space
        if (input === ' ') {
            if (confirmationModeRef.current === 'switch') {
                // Second space, switch to local
                confirmationModeRef.current = null
                actionInProgressRef.current = 'switching'
                resetConfirmation()
                setActionInProgress('switching')
                // Small delay to show the status message
                await new Promise(resolve => setTimeout(resolve, 100))
                onSwitchToLocal?.()
            } else {
                // First space, show confirmation
                confirmationModeRef.current = 'switch'
                setConfirmationWithTimeout('switch')
            }
            return
        }

        // Any other key cancels confirmation
        if (confirmationModeRef.current) {
            confirmationModeRef.current = null
            resetConfirmation()
        }
    }, [onExit, onSwitchToLocal, setConfirmationWithTimeout, resetConfirmation]))

    const getMessageColor = (type: BufferedMessage['type']): string => {
        switch (type) {
            case 'user': return 'magenta'
            case 'assistant': return 'cyan'
            case 'system': return 'blue'
            case 'tool': return 'yellow'
            case 'result': return 'green'
            case 'status': return 'gray'
            default: return 'white'
        }
    }

    const formatMessage = (msg: BufferedMessage): string => {
        const lines = msg.content.split('\n')
        const maxLineLength = terminalWidth - 10 // Account for borders and padding
        return lines.map(line => {
            if (line.length <= maxLineLength) return line
            const chunks: string[] = []
            for (let i = 0; i < line.length; i += maxLineLength) {
                chunks.push(line.slice(i, i + maxLineLength))
            }
            return chunks.join('\n')
        }).join('\n')
    }

    return (
        <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
            {/* Main content area with logs */}
            <Box 
                flexDirection="column" 
                width={terminalWidth}
                height={terminalHeight - 4}
                borderStyle="round"
                borderColor="gray"
                paddingX={1}
                overflow="hidden"
            >
                <Box flexDirection="column" marginBottom={1}>
                    <Text color="gray" bold>📡 Remote Mode - Claude Messages</Text>
                    <Text color="gray" dimColor>{'─'.repeat(Math.min(terminalWidth - 4, 60))}</Text>
                </Box>
                
                <Box flexDirection="column" height={terminalHeight - 10} overflow="hidden">
                    {messages.length === 0 ? (
                        <Text color="gray" dimColor>Waiting for messages...</Text>
                    ) : (
                        // Show only the last messages that fit in the available space
                        messages.slice(-Math.max(1, terminalHeight - 10)).map((msg) => (
                            <Box key={msg.id} flexDirection="column" marginBottom={1}>
                                <Text color={getMessageColor(msg.type)} dimColor>
                                    {formatMessage(msg)}
                                </Text>
                            </Box>
                        ))
                    )}
                </Box>
            </Box>

            {/* Modal overlay at the bottom */}
            <Box 
                width={terminalWidth}
                borderStyle="round"
                borderColor={
                    actionInProgress ? "gray" :
                    confirmationMode === 'exit' ? "red" : 
                    confirmationMode === 'switch' ? "yellow" : 
                    "green"
                }
                paddingX={2}
                justifyContent="center"
                alignItems="center"
                flexDirection="column"
            >
                <Box flexDirection="column" alignItems="center">
                    {actionInProgress === 'exiting' ? (
                        <Text color="gray" bold>
                            Exiting...
                        </Text>
                    ) : actionInProgress === 'switching' ? (
                        <Text color="gray" bold>
                            Switching to local mode...
                        </Text>
                    ) : confirmationMode === 'exit' ? (
                        <Text color="red" bold>
                            ⚠️  Press Ctrl-C again to exit completely
                        </Text>
                    ) : confirmationMode === 'switch' ? (
                        <Text color="yellow" bold>
                            ⏸️  Press space again to switch to local mode
                        </Text>
                    ) : (
                        <>
                            <Text color="green" bold>
                                📱 Press space to switch to local mode • Ctrl-C to exit
                            </Text>
                        </>
                    )}
                    {process.env.DEBUG && logPath && (
                        <Text color="gray" dimColor>
                            Debug logs: {logPath}
                        </Text>
                    )}
                </Box>
            </Box>
        </Box>
    )
}