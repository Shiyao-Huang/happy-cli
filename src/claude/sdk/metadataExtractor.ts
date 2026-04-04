/**
 * SDK Metadata Extractor
 * Captures available tools and slash commands from Claude SDK initialization
 */

import { query } from './query'
import type { SDKSystemMessage } from './types'
import type { QueryOptions } from './types'
import { logger } from '@/ui/logger'

export interface SDKMetadata {
    tools?: string[]
    slashCommands?: string[]
}

export type SDKMetadataExtractionOptions = Pick<
    QueryOptions,
    'allowedTools' | 'disallowedTools' | 'cwd' | 'mcpServers' | 'permissionMode' | 'settingsPath' | 'strictMcpConfig'
>;

/**
 * Extract SDK metadata by running a minimal query and capturing the init message
 * @returns SDK metadata containing tools and slash commands
 */
export async function extractSDKMetadata(options: SDKMetadataExtractionOptions = {}): Promise<SDKMetadata> {
    const abortController = new AbortController()
    
    try {
        logger.debug('[metadataExtractor] Starting SDK metadata extraction')
        
        // Run SDK with the same runtime inputs as the live session so surfaced-tool
        // metadata reflects the real contract instead of a detached helper config.
        const sdkQuery = query({
            prompt: 'hello',
            options: {
                maxTurns: 1,
                abort: abortController.signal,
                ...options,
            }
        })

        // Wait for the first system message which contains tools and slash commands
        for await (const message of sdkQuery) {
            if (message.type === 'system' && message.subtype === 'init') {
                const systemMessage = message as SDKSystemMessage
                
                const metadata: SDKMetadata = {
                    tools: systemMessage.tools,
                    slashCommands: systemMessage.slash_commands
                }
                
                logger.debug('[metadataExtractor] Captured SDK metadata:', metadata)
                
                // Abort the query since we got what we need
                abortController.abort()
                
                return metadata
            }
        }
        
        logger.debug('[metadataExtractor] No init message received from SDK')
        return {}
        
    } catch (error) {
        // Check if it's an abort error (expected)
        if (error instanceof Error && error.name === 'AbortError') {
            logger.debug('[metadataExtractor] SDK query aborted after capturing metadata')
            return {}
        }
        logger.debug('[metadataExtractor] Error extracting SDK metadata:', error)
        return {}
    }
}

/**
 * Extract SDK metadata asynchronously without blocking
 * Fires the extraction and updates metadata when complete
 */
export function extractSDKMetadataAsync(
    onComplete: (metadata: SDKMetadata) => void,
    options: SDKMetadataExtractionOptions = {},
): void {
    extractSDKMetadata(options)
        .then(metadata => {
            if (metadata.tools || metadata.slashCommands) {
                onComplete(metadata)
            }
        })
        .catch(error => {
            logger.debug('[metadataExtractor] Async extraction failed:', error)
        })
}
