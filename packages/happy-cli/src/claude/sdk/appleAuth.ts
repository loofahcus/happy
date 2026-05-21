import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { logger } from '@/lib'

let cachedPath: string | null | undefined

export function findAppleClaudeCodePath(): string | null {
    if (cachedPath !== undefined) return cachedPath

    // Check if @apple/claude-code is installed by looking for the wrapper script
    const npmGlobalPrefix = getNpmGlobalPrefix()
    if (npmGlobalPrefix) {
        const wrapperPath = join(npmGlobalPrefix, 'lib', 'node_modules', '@apple', 'claude-code', 'bin', 'cli.js')
        if (existsSync(wrapperPath)) {
            logger.debug(`[AppleAuth] Found Apple Claude Code wrapper at: ${wrapperPath}`)
            cachedPath = wrapperPath
            return wrapperPath
        }
    }

    // Fallback: check if 'claude' command resolves to apple-claude-code
    try {
        const resolved = execSync('which claude', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd: homedir() }).trim()
        if (resolved && existsSync(resolved)) {
            const target = execSync(`readlink -f ${resolved}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
            if (target.includes('apple-claude-code') || target.includes('@apple/claude-code')) {
                logger.debug(`[AppleAuth] Found Apple Claude Code via 'claude' command: ${resolved}`)
                cachedPath = resolved
                return resolved
            }
        }
    } catch {}

    cachedPath = null
    return null
}

function getNpmGlobalPrefix(): string | null {
    try {
        // Use the same node that's running this process
        const nodeDir = join(process.execPath, '..')
        return join(nodeDir, '..')
    } catch {
        return null
    }
}
