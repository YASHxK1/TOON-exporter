# 🪟 FloatTab

**Open any website in a small floating window, and actually interact with it, without leaving the tab you're working in.**

Ever wished you could watch a tutorial, keep an eye on a chat, or reference a doc while working in another tab, *without* alt tabbing back and forth? FloatTab does exactly that.

---

## What It Does

FloatTab is a Chrome extension that lets you pop any website out into a small **always on top floating window** (a.k.a. Picture in Picture). The magic is: it's not just a video preview, you can **click links, scroll, type into forms**, and fully interact with the page.

### Two Modes

| Mode | What Happens | When It Kicks In |
|---|---|---|
| **Interactive** ✅ | Opens a fully clickable, scrollable mini window of the site. You can use it like a normal browser tab, just smaller. | Most websites (default) |
| **View Only** 👁️ | Shows a live mirror of the tab. You can see the page updating in real time, but can't click inside the floating window. | Sites that block embedding (banks, some social media, etc.) |

FloatTab automatically picks the best mode. If a site blocks interactive mode, it seamlessly falls back to View Only. No error, no fuss.

---

## Installing

> FloatTab isn't on the Chrome Web Store (yet). You'll install it manually. It takes about 30 seconds.

1. **Download or clone** this folder to your computer.
2. Open Chrome and go to **`chrome://extensions`**.
3. Turn on **Developer mode** (toggle in the top right corner).
4. Click **"Load unpacked"** and select the `floattab` folder.
5. Done! You'll see the FloatTab icon in your toolbar.

> **Tip:** If the icon doesn't appear right away, click the puzzle piece icon (🧩) in Chrome's toolbar and pin FloatTab.

---

## How to Use

1. Navigate to any website you want to float.
2. Click the **FloatTab icon** in your toolbar.
3. Hit **"Float This Tab"**.
4. A floating window pops up. Drag it wherever you want on your screen.
5. To close it, click the FloatTab icon again and hit **"Close Float"**, or just close the floating window directly.

That's it. No accounts, no signups, no configuration.

---

## Requirements

- **Google Chrome 116 or newer** (released Aug 2023). The extension uses a modern Chrome feature called Document Picture in Picture that isn't available in older versions.
- Works on **Windows, macOS, and Linux**.
- **No internet connection required** for the extension itself. It works with whatever pages you already have open.

---

## Good to Know

- **Multiple floats are supported on secure sites.** FloatTab can keep multiple tabs open at once when they use the per-tab Document PiP path. Some insecure-origin sites may still fall back to Chrome's older single-window mirror behavior.
- **Chrome pages can't be floated.** The Settings page (`chrome://settings`), extensions page, and similar system pages can't be put into a floating window. That's a Chrome security restriction, not a bug.
- **DRM protected content** (like Netflix or Disney+) will show a black screen in View Only mode. This is a browser level protection and can't be bypassed.
- **Your data stays local.** FloatTab doesn't send any data anywhere. Everything happens right in your browser.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot Float This Page" | You're on a Chrome system page (`chrome://...`). Navigate to a real website first. |
| Floating window shows a blank page | The site may block embedding. FloatTab should auto switch to View Only mode. Try closing and reopening. |
| "Update Chrome" message | Your Chrome is older than version 116. Update via **Chrome → Settings → About Chrome**. |
| Icon doesn't appear in toolbar | Click the puzzle piece icon (🧩) in Chrome's toolbar → find FloatTab → click the pin icon. |

---

## Project Structure (for the curious)

```
floattab/
├── manifest.json        ← Extension config file (tells Chrome what FloatTab needs)
├── popup/               ← The little panel you see when you click the icon
├── background/          ← Runs behind the scenes to coordinate everything
├── content/             ← Gets injected into web pages to create the floating window
├── offscreen/           ← Handles the "View Only" mirror mode
└── icons/               ← Extension icons
```

---

## Version

**v1.0** · Built for Chrome 116+

---

<p align="center">
  <sub>Made with a mild obsession for multitasking.</sub>
</p>
