# Chrome DevTools Adapter

Native CDP (Chrome DevTools Protocol) adapter - no puppeteer dependency, just `ws`.

## Features

- Auto-launches Chrome with debugging enabled
- Auto-detects available ports (9222-9322 range)
- Supports headless and visible modes
- 25 tools for browser automation
- UID-based element selection (reliable)
- CSS selector support (convenient)

## Setup

Copy to your MCX adapters directory:

```bash
cp chrome-devtools.ts ~/.mcx/adapters/
```

No additional setup needed - Chrome is launched automatically.

## Usage with MCX

```typescript
// Launch browser (visible mode)
await browser.launch({ headless: false });

// List pages
const pages = await browser.listPages();
const targetId = pages[0].targetId;

// Navigate
await browser.navigate({ targetId, url: "https://example.com" });

// Wait for content
await browser.waitFor({ targetId, text: "Example Domain" });

// Get DOM snapshot with UIDs
const snapshot = await browser.snapshot({ targetId });

// Click by UID (reliable)
await browser.clickUid({ targetId, uid: "uid_5" });

// Or click by CSS selector
await browser.click({ targetId, selector: "button.submit" });

// Fill input
await browser.fill({ targetId, selector: "#email", value: "test@example.com" });

// Press key
await browser.pressKey({ targetId, key: "Enter" });

// Take screenshot
const screenshot = await browser.screenshot({ targetId });

// Close browser
await browser.close();
```

## Available Tools (25)

### Browser Control
| Tool | Description |
|------|-------------|
| `launch` | Launch Chrome (headless or visible) |
| `close` | Close browser and cleanup |

### Page Management
| Tool | Description |
|------|-------------|
| `listPages` | List all open tabs |
| `newPage` | Create new tab |
| `closePage` | Close a tab |
| `navigate` | Navigate to URL |

### DOM & Content
| Tool | Description |
|------|-------------|
| `snapshot` | Get DOM with UIDs for reliable selection |
| `getText` | Get page text content |
| `screenshot` | Capture page screenshot |
| `evaluate` | Execute JavaScript |

### Interaction (CSS Selector)
| Tool | Description |
|------|-------------|
| `click` | Click element by selector |
| `fill` | Fill input by selector |
| `hover` | Hover over element |

### Interaction (UID)
| Tool | Description |
|------|-------------|
| `clickUid` | Click element by UID from snapshot |
| `fillUid` | Fill input by UID from snapshot |

### Input & Navigation
| Tool | Description |
|------|-------------|
| `pressKey` | Press key or combo (Enter, Tab, Control+c) |
| `waitFor` | Wait for selector or text |
| `scroll` | Scroll page or to element |

### Emulation
| Tool | Description |
|------|-------------|
| `emulate` | Set viewport, device, color scheme |

### Files & Dialogs
| Tool | Description |
|------|-------------|
| `uploadFile` | Upload file to input |
| `handleDialog` | Accept/dismiss alerts |

### Debugging
| Tool | Description |
|------|-------------|
| `getConsoleMessages` | Get console logs |
| `getNetworkRequests` | Get network requests |

### Performance
| Tool | Description |
|------|-------------|
| `startTrace` | Start performance tracing |
| `stopTrace` | Stop trace and get web vitals |

## UID vs CSS Selectors

**CSS Selectors** - convenient but fragile:
```typescript
await browser.click({ targetId, selector: "#submit-btn" });
```

**UIDs** - reliable, from snapshot:
```typescript
// First get snapshot
const snapshot = await browser.snapshot({ targetId });
// Find element UID
const btn = snapshot.nodes.find(n => n.name.includes("Submit"));
// Click by UID
await browser.clickUid({ targetId, uid: btn.uid });
```

## Architecture

```
MCX Agent → chrome-devtools adapter → WebSocket → Chrome CDP
                    ↓
            Auto-launches Chrome
            with --remote-debugging-port
```

## Tested On

- [x] Windows
- [ ] macOS
- [ ] Linux
