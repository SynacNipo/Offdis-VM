# OffdisVM

Zero-dependency Node.js console that controls VirtualBox VMs through the VirtualBox Main API (via a PowerShell COM bridge) - with YouTube live-chat command control.

📖 **Full documentation: [wiki](https://github.com/SynacNipo/Offdis-VM/wiki)** (commands, macros, voting, snapshots, configuration)

> [!NOTE]
> This project was developed with the assistance of AI. All scripts are fine-tuned and contain no malicious intent of any kind.

## Requirements

- [VirtualBox](https://www.virtualbox.org/) 7.x installed (default `C:\Program Files\Oracle\VirtualBox`)
- [Node.js](https://nodejs.org/) 18 or newer
- A VM created in VirtualBox (settings.json, snapshots, etc. are all regular VirtualBox features)

## Install (no npm install needed - zero dependencies)

1. Click the green **Code** button on this page.
2. **Download ZIP** and extract it anywhere.
3. Open a terminal in the extracted folder and run:

```
npm start
```

That's it. No `npm install`, no node_modules.

## Quick start

```
list                 VM picker (arrows + Enter) - auto-starts if powered off
key enter            send a key (also: key ctrl+alt+del - key ? = all keys)
type hello           type text (no Enter)
send notepad         type text + Enter
combo win+r          key combo with hold
live <videoId>       connect YouTube live chat - live stop to disconnect
help | ?             this help - exit | quit
```

At the prompt the `!` prefix is optional for exec commands (`key enter` = `!key enter`); chat always needs it.

Chat can post `!key`, `!type`, `!send`, `!combo`, `!import`, `!wait <dur>` (e.g. `!wait 2s`), `!startvm`, `!restartvm`, `!revertvm`, `!voteban <author>` - chains of commands in one message run atomically. `!startvm` boots a powered-off VM. `!restartvm` / `!revertvm` / `!voteban` are vote-gated (2 votes) and the VM ops share a 15 s cooldown. Macros live in `macros/` (see `macros/readthis.txt`).

More details for everything above: **[[wiki]](https://github.com/SynacNipo/Offdis-VM/wiki)**

## Session logs

Every session's console output is saved automatically to `logs/` (a timestamped file) when you exit (Ctrl+C) or run `!live stop`.

## Development

Zero dependencies means there's nothing to install. Run the `node:test` suite and a syntax check of every source file:

```
npm test
npm run check
```

CI (GitHub Actions) runs both on Windows with Node 18/20/22 for every push and pull request.

## Credits

Live chat polling uses the vendored `modern-youtubechat` project (`modern-youtubechat/dist/client.js`).

Enjoying the script? Sharing the repo or linking it in your YouTube description helps others find it: https://github.com/SynacNipo/Offdis-VM
