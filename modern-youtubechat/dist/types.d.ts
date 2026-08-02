export type AuthorRole = 'owner' | 'moderator' | 'member' | 'verified' | 'normal';
export interface ChatMessage {
    id: string;
    author: {
        name: string;
        thumbnailUrl?: string;
        channelId?: string;
    };
    message: string;
    timestamp: Date;
    timestampText: string;
    role: AuthorRole;
    isMembership: boolean;
    isPaid: boolean;
    amountText?: string;
}
//# sourceMappingURL=types.d.ts.map