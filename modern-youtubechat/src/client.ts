import { ChatMessage, AuthorRole } from './types.js';

const YT_BASE = 'https://www.youtube.com';
const YT_API = 'https://www.youtube.com/youtubei/v1';

interface YTCfg {
  INNERTUBE_API_KEY?: string;
  INNERTUBE_CONTEXT?: Record<string, unknown>;
  [key: string]: unknown;
}

interface LiveChatConfig {
  apiKey: string;
  context: Record<string, unknown>;
  continuation: string;
  videoId: string;
}

function extractBraceBlock(html: string, startIdx: number): string | null {
  if (html[startIdx] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < html.length; i++) {
    const ch = html[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.substring(startIdx, i + 1);
    }
  }
  return null;
}

function extractYtCfg(html: string): YTCfg | null {
  const marker = 'ytcfg.set({';
  let idx = html.indexOf(marker);
  if (idx !== -1) {
    const json = extractBraceBlock(html, idx + marker.length - 1);
    if (json) {
      try { return JSON.parse(json) as YTCfg; } catch { /* fall through */ }
    }
  }

  const altStart = html.indexOf('ytcfg.data_=');
  if (altStart === -1) {
    const altStart2 = html.indexOf('ytcfg.data_ =');
    if (altStart2 !== -1) {
      const braceIdx = html.indexOf('{', altStart2);
      if (braceIdx !== -1) {
        const json = extractBraceBlock(html, braceIdx);
        if (json) {
          try { return JSON.parse(json) as YTCfg; } catch { /* fall through */ }
        }
      }
    }
  } else {
    const braceIdx = html.indexOf('{', altStart);
    if (braceIdx !== -1) {
      const json = extractBraceBlock(html, braceIdx);
      if (json) {
        try { return JSON.parse(json) as YTCfg; } catch { /* fall through */ }
      }
    }
  }

  return null;
}

function extractYtInitialData(html: string): Record<string, unknown> | null {
  const patterns = [
    'ytInitialData = {',
    'ytInitialData={',
    'window["ytInitialData"] = {',
    'window["ytInitialData"]={',
  ];
  for (const pattern of patterns) {
    const idx = html.indexOf(pattern);
    if (idx !== -1) {
      const braceIdx = html.indexOf('{', idx);
      if (braceIdx !== -1) {
        const json = extractBraceBlock(html, braceIdx);
        if (json) {
          try { return JSON.parse(json) as Record<string, unknown>; } catch { /* continue */ }
        }
      }
    }
  }
  return null;
}

function getContinuationFromArray(continuations: unknown): string | null {
  if (!Array.isArray(continuations) || continuations.length === 0) return null;
  const cont = continuations[0] as Record<string, unknown>;
  if (!cont || typeof cont !== 'object') return null;

  const containers = ['nextRelayContinuationData', 'invalidationContinuationData', 'timedContinuationData', 'reloadContinuationData'];
  for (const container of containers) {
    const data = cont[container] as Record<string, unknown> | undefined;
    if (data?.continuation && typeof data.continuation === 'string') {
      return data.continuation;
    }
  }

  if (typeof cont.continuation === 'string') {
    return cont.continuation;
  }

  return null;
}

function extractContinuation(initialData: Record<string, unknown>): string | null {
  const liveChatPaths = [
    (d: Record<string, unknown>) => (d as any)?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer,
    (d: Record<string, unknown>) => (d as any)?.continuationContents?.liveChatContinuation,
    (d: Record<string, unknown>) => (d as any)?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.find(
      (c: any) => c?.liveChatRenderer
    )?.liveChatRenderer,
  ];

  for (const getPath of liveChatPaths) {
    const renderer = getPath(initialData) as Record<string, unknown> | undefined;
    if (!renderer) continue;

    const cont = getContinuationFromArray(renderer['continuations']);
    if (cont) return cont;
  }

  return null;
}

function extractAuthorRole(badges: unknown[] | undefined): AuthorRole {
  if (!badges || !Array.isArray(badges)) return 'normal';
  for (const badge of badges) {
    const renderer = (badge as Record<string, unknown>)?.['liveChatAuthorBadgeRenderer'] as Record<string, unknown> | undefined;
    if (!renderer) continue;
    const icon = (renderer?.['icon'] as Record<string, unknown> | undefined)?.['iconType'] as string | undefined;
    if (icon === 'OWNER') return 'owner';
    if (icon === 'MODERATOR') return 'moderator';
    if (icon === 'VERIFIED') return 'verified';
    if (icon?.includes('MEMBER')) return 'member';
  }
  return 'normal';
}

function extractText(data: unknown): string {
  if (!data) return '';
  if (typeof data === 'string') return data;
  const d = data as Record<string, unknown>;
  if (typeof d['simpleText'] === 'string') return d['simpleText'] as string;
  const runs = d['runs'] as unknown;
  if (Array.isArray(runs)) {
    return (runs as Array<Record<string, unknown>>)
      .map(r => r['text'] ?? '')
      .join('');
  }
  return '';
}

function extractMessage(runs: unknown[]): string {
  if (!Array.isArray(runs)) return '';
  return runs.map(r => {
    const run = r as Record<string, unknown>;
    if (run['text']) return run['text'];
    if (run['emoji'] && typeof run['emoji'] === 'object') {
      const emoji = run['emoji'] as Record<string, unknown>;
      return (emoji['emojiId'] as string) ?? (emoji['shortcuts'] as string[])?.[0] ?? '[emoji]';
    }
    return '';
  }).join('');
}

function parseChatItem(item: Record<string, unknown>): ChatMessage | null {
  const renderer = item['liveChatTextMessageRenderer'] as Record<string, unknown> | undefined;
  if (!renderer) return null;

  const id = renderer['id'] as string;
  if (!id) return null;

  const authorName = extractText(renderer['authorName']);
  const messageObj = renderer['message'] as Record<string, unknown> | undefined;
  const message = extractMessage(messageObj?.['runs'] as unknown[]);
  const timestampUsec = renderer['timestampUsec'] as string | undefined;
  const timestampText = extractText(renderer['timestampText']);
  const badges = renderer['authorBadges'] as unknown[] | undefined;
  const authorPhoto = renderer['authorPhoto'] as Record<string, unknown> | undefined;

  const timestamp = timestampUsec
    ? new Date(Number(BigInt(timestampUsec) / 1000n))
    : new Date();

  const role = extractAuthorRole(badges);

  const channelId = ((renderer['authorExternalChannelId'] as string | undefined) ?? '');

  let thumbnailUrl: string | undefined;
  if (authorPhoto) {
    const thumbs = authorPhoto['thumbnails'] as Array<Record<string, unknown>> | undefined;
    if (thumbs && thumbs.length > 0) {
      thumbnailUrl = thumbs[thumbs.length - 1]['url'] as string;
    }
  }

  return {
    id,
    author: {
      name: authorName,
      thumbnailUrl,
      channelId,
    },
    message,
    timestamp,
    timestampText,
    role,
    isMembership: false,
    isPaid: false,
  };
}

function parsePaidMessage(item: Record<string, unknown>): ChatMessage | null {
  const types = ['liveChatPaidMessageRenderer', 'liveChatPaidStickerRenderer'] as const;
  for (const type of types) {
    const renderer = item[type] as Record<string, unknown> | undefined;
    if (!renderer) continue;

    const id = renderer['id'] as string;
    if (!id) continue;

    const authorName = extractText(renderer['authorName']);
    const messageObj = renderer['message'] as Record<string, unknown> | undefined;
    const message = extractMessage(messageObj?.['runs'] as unknown[] ?? []);
    const timestampUsec = renderer['timestampUsec'] as string | undefined;
    const timestampText = extractText(renderer['timestampText']);
    const badges = renderer['authorBadges'] as unknown[] | undefined;
    const authorPhoto = renderer['authorPhoto'] as Record<string, unknown> | undefined;
    const purchaseAmount = extractText(renderer['purchaseAmountText']);

    const timestamp = timestampUsec
      ? new Date(Number(BigInt(timestampUsec) / 1000n))
      : new Date();

    const role = extractAuthorRole(badges);

    let thumbnailUrl: string | undefined;
    if (authorPhoto) {
      const thumbs = authorPhoto['thumbnails'] as Array<Record<string, unknown>> | undefined;
      if (thumbs && thumbs.length > 0) {
        thumbnailUrl = thumbs[thumbs.length - 1]['url'] as string;
      }
    }

    return {
      id,
      author: {
        name: authorName,
        thumbnailUrl,
        channelId: renderer['authorExternalChannelId'] as string | undefined,
      },
      message,
      timestamp,
      timestampText,
      role,
      isMembership: false,
      isPaid: true,
      amountText: purchaseAmount,
    };
  }
  return null;
}

function parseMemberMessage(item: Record<string, unknown>): ChatMessage | null {
  const renderer = item['liveChatMembershipItemRenderer'] as Record<string, unknown> | undefined;
  if (!renderer) return null;

  const id = renderer['id'] as string;
  if (!id) return null;

  const authorName = extractText(renderer['authorName']);
  const headerText = extractText(renderer['headerSubtext']);
  const timestampUsec = renderer['timestampUsec'] as string | undefined;
  const timestampText = extractText(renderer['timestampText']);
  const badges = renderer['authorBadges'] as unknown[] | undefined;
  const authorPhoto = renderer['authorPhoto'] as Record<string, unknown> | undefined;

  const timestamp = timestampUsec
    ? new Date(Number(BigInt(timestampUsec) / 1000n))
    : new Date();

  let thumbnailUrl: string | undefined;
  if (authorPhoto) {
    const thumbs = authorPhoto['thumbnails'] as Array<Record<string, unknown>> | undefined;
    if (thumbs && thumbs.length > 0) {
      thumbnailUrl = thumbs[thumbs.length - 1]['url'] as string;
    }
  }

  return {
    id,
    author: {
      name: authorName,
      thumbnailUrl,
      channelId: renderer['authorExternalChannelId'] as string | undefined,
    },
    message: headerText || 'Joined as member',
    timestamp,
    timestampText,
    role: 'member',
    isMembership: true,
    isPaid: false,
  };
}

function parseActions(actions: unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const action of actions) {
    const a = action as Record<string, unknown>;
    const addChatItem = a['addChatItemAction'] as Record<string, unknown> | undefined
      ?? a['addLiveChatTickerItemAction'] as Record<string, unknown> | undefined;

    if (!addChatItem || !addChatItem['item']) continue;

    const item = addChatItem['item'] as Record<string, unknown>;

    const textMsg = parseChatItem(item);
    if (textMsg) { messages.push(textMsg); continue; }

    const paidMsg = parsePaidMessage(item);
    if (paidMsg) { messages.push(paidMsg); continue; }

    const memberMsg = parseMemberMessage(item);
    if (memberMsg) { messages.push(memberMsg); continue; }
  }
  return messages;
}

function parsePollResponse(data: Record<string, unknown>): {
  messages: ChatMessage[];
  continuation: string | null;
} {
  const continuationContents = data['continuationContents'] as Record<string, unknown> | undefined;
  const liveChatCont = continuationContents?.['liveChatContinuation'] as Record<string, unknown> | undefined;
  const actions = (liveChatCont?.['actions'] as unknown[]) ?? [];

  const messages = parseActions(actions);
  const nextContinuation = getContinuationFromArray(liveChatCont?.['continuations']);

  return { messages, continuation: nextContinuation };
}

export async function initLiveChat(videoId: string): Promise<LiveChatConfig> {
  const url = `${YT_BASE}/watch?v=${encodeURIComponent(videoId)}`;
  const resp = await fetch(url, {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch video page: ${resp.status} ${resp.statusText}`);
  }

  const html = await resp.text();

  const ytcfg = extractYtCfg(html);
  if (!ytcfg) {
    throw new Error('Could not extract YouTube config from page');
  }

  const apiKey = ytcfg.INNERTUBE_API_KEY;
  if (!apiKey) {
    throw new Error('Could not extract InnerTube API key from page');
  }

  const context = ytcfg.INNERTUBE_CONTEXT;
  if (!context) {
    throw new Error('Could not extract InnerTube context from page');
  }

  const initialData = extractYtInitialData(html);
  if (!initialData) {
    throw new Error('Could not extract initial data from page');
  }

  const continuation = extractContinuation(initialData);
  if (!continuation) {
    throw new Error('No live chat continuation found. The stream may not be live or chat may be disabled.');
  }

  return { apiKey, context, continuation, videoId };
}

export async function pollChat(config: LiveChatConfig): Promise<{
  messages: ChatMessage[];
  config: LiveChatConfig;
}> {
  const url = `${YT_API}/live_chat/get_live_chat?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`;

  const body = {
    context: config.context,
    continuation: config.continuation,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Poll failed: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as Record<string, unknown>;
  const { messages, continuation } = parsePollResponse(data);

  if (!continuation) {
    throw new Error('Live chat ended or continuation token expired');
  }

  return {
    messages,
    config: { ...config, continuation },
  };
}

export function formatMessage(msg: ChatMessage): string {
  const time = msg.timestamp.toLocaleTimeString('en-US', { hour12: false });
  let badge = '';
  switch (msg.role) {
    case 'owner':
      badge = '[OWNER]';
      break;
    case 'moderator':
      badge = '[MOD]';
      break;
    case 'member':
      badge = '[MEMBER]';
      break;
    case 'verified':
      badge = '[VERIFIED]';
      break;
  }

  let extra = '';
  if (msg.isPaid && msg.amountText) {
    extra = ` (${msg.amountText})`;
  }

  return `${time} ${badge} ${msg.author.name}${extra}: ${msg.message}`;
}
