# OffdisVM

Zero-dependency Node.js console that controls VirtualBox VMs through the VirtualBox Main API (via a PowerShell COM bridge) - with YouTube live-chat command control.

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

## Usage

Start the CLI, pick your VM from the `list` menu, and control it:

```
list                 VM picker (arrows + Enter) - auto-starts if powered off
info [<name>]        show VM details
pause | resume       pause / resume the active VM
stop                 power off the active VM (ACPI)
!key <key>           send a key:  !key enter - !key ctrl+alt+del - !key ? = all keys
!type <text>         type text into the VM (no Enter)
!send <text>         type text and press Enter
!combo <chord>       key combo with hold:  !combo win+r
!import <name>       run a macro from src/imports/ (e.g. !import this)
!revertvm            revert to the latest snapshot
!restartvm           restart the VM
!live <videoId>      connect YouTube live chat - !live stop to disconnect
!clearLog            clear the console
help | ?             this help - exit | quit
```

If no VM is active when a command runs, the first running VM is auto-selected.

## YouTube live chat control

Viewers in your live chat can drive the VM by posting commands - `!key`, `!type`, `!send`, `!combo` and `!import`. Commands are fully open by design: anyone in chat can type, so use VirtualBox snapshots as your safety net. Chat roles are shown as `[Mod]` / `[Owner]` tags.

`!revertvm` and `!restartvm` are vote-gated in chat: a minimum number of distinct chatters must request the command (default **2**) before it triggers. `!revert` and `!restart` work as shorthand aliases. Configure the thresholds in `src/settings.json`:

```json
"voting": {
  "revertVMVoteThreshold": 2,
  "restartVMVoteThreshold": 2
}
```

`!revertvm` reverts the active VM to its latest snapshot; `!restartvm` powers it off and back on. Both stop the VM first, wait for it to fully power down, then relaunch it.

Macros are simple text files in `src/imports/`:

```
# comments start with #
!combo win+r
!wait 1000
!type notepad
!key enter
```

## Session logs

Every session's console output is saved automatically to `logs/` (a timestamped file) when you exit (Ctrl+C) or run `!live stop`.

## Configuration

Colors and role tags can be changed in `src/settings.json` (auto-created on first run).

## Credits

Live chat polling uses the vendored `modern-youtubechat` project (`modern-youtubechat/dist/client.js`) - custom-built for OffdisVM.

Enjoying the script? No pressure at all, but if you'd like to help others find it, feel free to share the repo: https://github.com/SynacNipo/Offdis-VM
