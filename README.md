# Sound Words — SillyTavern

A local SillyTavern extension that turns configured words/phrases in messages into clickable elements that play local audio.

## Features

- Words and phrases.
- Two trigger types: exact word/phrase or word combination.
- In combination mode, use `+` between terms (e.g. `knocks+side+fist`); the first term becomes clickable when all terms appear in the same sentence.
- Case-insensitive matching.
- One or multiple occurrences in the same message.
- Multiple audio files per word; a random file is chosen on each click.
- Individual volume per word.
- Local files selected through the browser; no URLs are used.
- Audio blobs are stored in the browser's IndexedDB.
- Option to include or ignore user messages.
- Option to allow or prevent overlapping sounds.
- Works with messages rendered after installation via MutationObserver.
- Does not alter the original saved chat text; only the displayed DOM.

## Manual installation

Copy the `st-sound-words` folder to:

`SillyTavern/public/scripts/extensions/third-party/st-sound-words/`

Then reload SillyTavern and enable **Sound Words** in the extensions panel.

## Notes

The selected files are not uploaded to the server by this extension. They are stored in the device's browser storage. Clearing the site's/browser's data can delete these files.

## Android + Termux installation

1. Download `st-sound-words.zip` to the Android Downloads folder.
2. In Termux, run:

```bash
termux-setup-storage
pkg install unzip -y
cd ~/SillyTavern
mkdir -p public/scripts/extensions/third-party
rm -rf public/scripts/extensions/third-party/st-sound-words
unzip -q ~/storage/downloads/st-sound-words.zip -d public/scripts/extensions/third-party
```

3. Restart or reload SillyTavern.
4. Open **Extensions** → **Sound Words** and enable the extension.

If `~/SillyTavern` does not exist, find the folder with:

```bash
find ~ -maxdepth 4 -type d -name SillyTavern 2>/dev/null
```

Then enter the folder you found and run the commands starting from `mkdir`.

## How to configure

Create an entry under **Add word**, choose the trigger type, enter a word/phrase (or terms separated by `+` in combination mode), and use **Add audio file(s)** to select one or more files from Android. Each click randomly chooses one of the audio files for that entry.

Volume is individual for each entry. By default, sounds can overlap. Uncheck **Allow simultaneous sounds** to stop the previous sound when another one is triggered.

By default, user messages are ignored. Enable **Include my messages** to make words in your own messages clickable as well.

## Storage

The rules (word, volume, and audio names/IDs) are stored in the extension settings. The file contents are stored in the browser's IndexedDB. This means the audio does not need to be in a folder publicly accessible to SillyTavern and is not loaded from a URL.

Do not clear the site/browser data for the address used to open SillyTavern without first backing up your audio files. `localhost`, `127.0.0.1`, and other addresses may have separate browser storage.

UI note: the word/phrase field is a normal desktop web input and is explicitly kept visible and focusable.
