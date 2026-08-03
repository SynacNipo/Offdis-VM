import { ChatMessage } from './types.js';
interface LiveChatConfig {
    apiKey: string;
    context: Record<string, unknown>;
    continuation: string;
    videoId: string;
    title?: string | null;
    host?: string | null;
}
export declare function initLiveChat(videoId: string): Promise<LiveChatConfig>;
export declare function pollChat(config: LiveChatConfig): Promise<{
    messages: ChatMessage[];
    config: LiveChatConfig;
}>;
export declare function formatMessage(msg: ChatMessage): string;
export {};
//# sourceMappingURL=client.d.ts.map