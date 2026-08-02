#!/usr/bin/env node
import { initLiveChat, pollChat, formatMessage } from './client.js';
function printUsage() {
    console.error('Usage: ylc --live <videoId>');
    console.error('');
    console.error('Options:');
    console.error('  --live <videoId>   YouTube live stream video ID to connect to');
    console.error('  -h, --help         Show this help message');
    process.exit(1);
}
function parseArgs() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
        printUsage();
    }
    const liveIndex = args.indexOf('--live');
    if (liveIndex === -1) {
        console.error('Error: --live flag is required');
        printUsage();
    }
    const videoId = args[liveIndex + 1];
    if (!videoId || videoId.startsWith('-')) {
        console.error('Error: missing video ID after --live');
        printUsage();
    }
    return videoId;
}
async function main() {
    const videoId = parseArgs();
    process.stderr.write(`Connecting to live stream ${videoId}...\n`);
    try {
        let config = await initLiveChat(videoId);
        process.stderr.write('Connected. Streaming chat messages...\n');
        process.stderr.write('-'.repeat(60) + '\n');
        let primed = false;
        while (true) {
            const result = await pollChat(config);
            if (primed) {
                for (const msg of result.messages) {
                    console.log(formatMessage(msg));
                }
            }
            else {
                primed = true;
            }
            config = result.config;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=index.js.map