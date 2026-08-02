const YT_BASE = 'https://www.youtube.com';
const YT_API = 'https://www.youtube.com/youtubei/v1';
function extractBraceBlock(html, startIdx) {
    if (html[startIdx] !== '{')
        return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIdx; i < html.length; i++) {
        const ch = html[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (inString) {
            if (ch === '\\') {
                escape = true;
            }
            else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{')
            depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0)
                return html.substring(startIdx, i + 1);
        }
    }
    return null;
}
function extractYtCfg(html) {
    const marker = 'ytcfg.set({';
    let idx = html.indexOf(marker);
    if (idx !== -1) {
        const json = extractBraceBlock(html, idx + marker.length - 1);
        if (json) {
            try {
                return JSON.parse(json);
            }
            catch { /* fall through */ }
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
                    try {
                        return JSON.parse(json);
                    }
                    catch { /* fall through */ }
                }
            }
        }
    }
    else {
        const braceIdx = html.indexOf('{', altStart);
        if (braceIdx !== -1) {
            const json = extractBraceBlock(html, braceIdx);
            if (json) {
                try {
                    return JSON.parse(json);
                }
                catch { /* fall through */ }
            }
        }
    }
    return null;
}
function extractYtInitialData(html) {
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
                    try {
                        return JSON.parse(json);
                    }
                    catch { /* continue */ }
                }
            }
        }
    }
    return null;
}
function getContinuationFromArray(continuations) {
    if (!Array.isArray(continuations) || continuations.length === 0)
        return null;
    const cont = continuations[0];
    if (!cont || typeof cont !== 'object')
        return null;
    const containers = ['nextRelayContinuationData', 'invalidationContinuationData', 'timedContinuationData', 'reloadContinuationData'];
    for (const container of containers) {
        const data = cont[container];
        if (data?.continuation && typeof data.continuation === 'string') {
            return data.continuation;
        }
    }
    if (typeof cont.continuation === 'string') {
        return cont.continuation;
    }
    return null;
}
function extractContinuation(initialData) {
    const liveChatPaths = [
        (d) => d?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer,
        (d) => d?.continuationContents?.liveChatContinuation,
        (d) => d?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.find((c) => c?.liveChatRenderer)?.liveChatRenderer,
    ];
    for (const getPath of liveChatPaths) {
        const renderer = getPath(initialData);
        if (!renderer)
            continue;
        const cont = getContinuationFromArray(renderer['continuations']);
        if (cont)
            return cont;
    }
    return null;
}
function extractAuthorRole(badges) {
    if (!badges || !Array.isArray(badges))
        return 'normal';
    for (const badge of badges) {
        const renderer = badge?.['liveChatAuthorBadgeRenderer'];
        if (!renderer)
            continue;
        const icon = renderer?.['icon']?.['iconType'];
        if (icon === 'OWNER')
            return 'owner';
        if (icon === 'MODERATOR')
            return 'moderator';
        if (icon === 'VERIFIED')
            return 'verified';
        if (icon?.includes('MEMBER'))
            return 'member';
    }
    return 'normal';
}
function extractText(data) {
    if (!data)
        return '';
    if (typeof data === 'string')
        return data;
    const d = data;
    if (typeof d['simpleText'] === 'string')
        return d['simpleText'];
    const runs = d['runs'];
    if (Array.isArray(runs)) {
        return runs
            .map(r => r['text'] ?? '')
            .join('');
    }
    return '';
}
function extractMessage(runs) {
    if (!Array.isArray(runs))
        return '';
    return runs.map(r => {
        const run = r;
        if (run['text'])
            return run['text'];
        if (run['emoji'] && typeof run['emoji'] === 'object') {
            const emoji = run['emoji'];
            return emoji['emojiId'] ?? emoji['shortcuts']?.[0] ?? '[emoji]';
        }
        return '';
    }).join('');
}
function parseChatItem(item) {
    const renderer = item['liveChatTextMessageRenderer'];
    if (!renderer)
        return null;
    const id = renderer['id'];
    if (!id)
        return null;
    const authorName = extractText(renderer['authorName']);
    const messageObj = renderer['message'];
    const message = extractMessage(messageObj?.['runs']);
    const timestampUsec = renderer['timestampUsec'];
    const timestampText = extractText(renderer['timestampText']);
    const badges = renderer['authorBadges'];
    const authorPhoto = renderer['authorPhoto'];
    const timestamp = timestampUsec
        ? new Date(Number(BigInt(timestampUsec) / 1000n))
        : new Date();
    const role = extractAuthorRole(badges);
    const channelId = (renderer['authorExternalChannelId'] ?? '');
    let thumbnailUrl;
    if (authorPhoto) {
        const thumbs = authorPhoto['thumbnails'];
        if (thumbs && thumbs.length > 0) {
            thumbnailUrl = thumbs[thumbs.length - 1]['url'];
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
function parsePaidMessage(item) {
    const types = ['liveChatPaidMessageRenderer', 'liveChatPaidStickerRenderer'];
    for (const type of types) {
        const renderer = item[type];
        if (!renderer)
            continue;
        const id = renderer['id'];
        if (!id)
            continue;
        const authorName = extractText(renderer['authorName']);
        const messageObj = renderer['message'];
        const message = extractMessage(messageObj?.['runs'] ?? []);
        const timestampUsec = renderer['timestampUsec'];
        const timestampText = extractText(renderer['timestampText']);
        const badges = renderer['authorBadges'];
        const authorPhoto = renderer['authorPhoto'];
        const purchaseAmount = extractText(renderer['purchaseAmountText']);
        const timestamp = timestampUsec
            ? new Date(Number(BigInt(timestampUsec) / 1000n))
            : new Date();
        const role = extractAuthorRole(badges);
        let thumbnailUrl;
        if (authorPhoto) {
            const thumbs = authorPhoto['thumbnails'];
            if (thumbs && thumbs.length > 0) {
                thumbnailUrl = thumbs[thumbs.length - 1]['url'];
            }
        }
        return {
            id,
            author: {
                name: authorName,
                thumbnailUrl,
                channelId: renderer['authorExternalChannelId'],
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
function parseMemberMessage(item) {
    const renderer = item['liveChatMembershipItemRenderer'];
    if (!renderer)
        return null;
    const id = renderer['id'];
    if (!id)
        return null;
    const authorName = extractText(renderer['authorName']);
    const headerText = extractText(renderer['headerSubtext']);
    const timestampUsec = renderer['timestampUsec'];
    const timestampText = extractText(renderer['timestampText']);
    const badges = renderer['authorBadges'];
    const authorPhoto = renderer['authorPhoto'];
    const timestamp = timestampUsec
        ? new Date(Number(BigInt(timestampUsec) / 1000n))
        : new Date();
    let thumbnailUrl;
    if (authorPhoto) {
        const thumbs = authorPhoto['thumbnails'];
        if (thumbs && thumbs.length > 0) {
            thumbnailUrl = thumbs[thumbs.length - 1]['url'];
        }
    }
    return {
        id,
        author: {
            name: authorName,
            thumbnailUrl,
            channelId: renderer['authorExternalChannelId'],
        },
        message: headerText || 'Joined as member',
        timestamp,
        timestampText,
        role: 'member',
        isMembership: true,
        isPaid: false,
    };
}
function parseActions(actions) {
    const messages = [];
    for (const action of actions) {
        const a = action;
        const addChatItem = a['addChatItemAction']
            ?? a['addLiveChatTickerItemAction'];
        if (!addChatItem || !addChatItem['item'])
            continue;
        const item = addChatItem['item'];
        const textMsg = parseChatItem(item);
        if (textMsg) {
            messages.push(textMsg);
            continue;
        }
        const paidMsg = parsePaidMessage(item);
        if (paidMsg) {
            messages.push(paidMsg);
            continue;
        }
        const memberMsg = parseMemberMessage(item);
        if (memberMsg) {
            messages.push(memberMsg);
            continue;
        }
    }
    return messages;
}
function parsePollResponse(data) {
    const continuationContents = data['continuationContents'];
    const liveChatCont = continuationContents?.['liveChatContinuation'];
    const actions = liveChatCont?.['actions'] ?? [];
    const messages = parseActions(actions);
    const nextContinuation = getContinuationFromArray(liveChatCont?.['continuations']);
    return { messages, continuation: nextContinuation };
}
export async function initLiveChat(videoId) {
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
export async function pollChat(config) {
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
    const data = await resp.json();
    const { messages, continuation } = parsePollResponse(data);
    if (!continuation) {
        throw new Error('Live chat ended or continuation token expired');
    }
    return {
        messages,
        config: { ...config, continuation },
    };
}
export function formatMessage(msg) {
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
//# sourceMappingURL=client.js.map