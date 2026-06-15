import { invoke } from '@tauri-apps/api/core';
import { LLMProviderInterface, ChatMessage, LLMResponse } from '../types';
import { LLMProvider } from '../../../stores/settingsStore';

interface CodexWireTool {
    type: 'function';
    name: string;
    description?: string;
    parameters: any;
    strict: boolean;
}

export class CodexProvider implements LLMProviderInterface {
    provider: LLMProvider = 'codex';

    async sendMessage(
        messages: ChatMessage[],
        _apiKey: string,
        model: string,
        tools?: any[]
    ): Promise<LLMResponse> {
        const response = await invoke<LLMResponse>('codex_send_message', {
            request: {
                model,
                messages,
                tools: (tools || []).map(this.toCodexTool),
            },
        });

        return {
            content: response.content || '',
            toolCalls: response.toolCalls || [],
        };
    }

    async streamMessage(
        messages: ChatMessage[],
        apiKey: string,
        model: string,
        tools: any[] | undefined,
        onChunk: (content: string) => void,
        onToolCalls: (toolCalls: any[]) => void,
        onComplete: () => void | Promise<void>,
        onError: (error: string) => void
    ): Promise<void> {
        try {
            const response = await this.sendMessage(messages, apiKey, model, tools);
            if (response.content) {
                onChunk(response.content);
            }
            if (response.toolCalls && response.toolCalls.length > 0) {
                onToolCalls(response.toolCalls);
            }
            await onComplete();
        } catch (error: any) {
            onError(error?.message || 'Codex request failed');
        }
    }

    private toCodexTool(tool: any): CodexWireTool {
        return {
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema || tool.parameters || {},
            strict: false,
        };
    }
}
