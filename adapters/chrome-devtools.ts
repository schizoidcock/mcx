/**
 * Chrome DevTools Protocol (CDP) Adapter for MCX
 *
 * Native CDP integration - no external dependencies (except ws).
 * Auto-launches Chrome with debugging enabled.
 */
import { defineAdapter } from "@papicandela/mcx-adapters";
import { WebSocket } from "ws";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { platform, tmpdir } from "os";
import { join } from "path";

/**
 * Escape a string for safe use in JavaScript string literals.
 * Prevents script injection via selector/text parameters.
 */
function escapeJsString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")   // Escape backslashes first
    .replace(/'/g, "\\'")     // Escape single quotes
    .replace(/"/g, '\\"')     // Escape double quotes
    .replace(/\n/g, "\\n")    // Escape newlines
    .replace(/\r/g, "\\r")    // Escape carriage returns
    .replace(/\t/g, "\\t")    // Escape tabs
    .replace(/</g, "\\x3c")   // Escape < to prevent </script> injection
    .replace(/>/g, "\\x3e");  // Escape >
}

interface CDPSession {
  ws: WebSocket;
  id: number;
  callbacks: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
}

let session: CDPSession | null = null;
let chromeProcess: ChildProcess | null = null;
let currentWsUrl: string | null = null;
let currentHeadless = true;
let connectionPromise: Promise<CDPSession> | null = null;
let currentUserDataDir: string | null = null;
let currentPort: number | null = null;

// Track active trace sessions per target
const activeTraceSessions: Map<string, string> = new Map();

// Port range for CDP - will try to find an available port
const CDP_PORT_START = 9222;
const CDP_PORT_END = 9322;

/**
 * Get or create user data directory for Chrome
 * Uses a unique temp directory to avoid conflicts with existing Chrome instances
 */
function getUserDataDir(): string {
  if (!currentUserDataDir) {
    const sessionId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    currentUserDataDir = join(tmpdir(), `mcx-chrome-${sessionId}`);
    mkdirSync(currentUserDataDir, { recursive: true });
  }
  return currentUserDataDir;
}

/**
 * Find Chrome executable path based on OS
 */
function findChromePath(): string | null {
  const os = platform();

  if (os === "win32") {
    const paths = [
      process.env["PROGRAMFILES(X86)"] &&
        join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
      process.env.PROGRAMFILES &&
        join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA &&
        join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ].filter(Boolean) as string[];

    for (const p of paths) {
      if (existsSync(p)) return p;
    }
  } else if (os === "darwin") {
    const paths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
  } else {
    const paths = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
  }

  return null;
}

/**
 * Kill Chrome process
 */
async function killChrome(): Promise<void> {
  // Close WebSocket
  if (session?.ws) {
    session.ws.close();
    session = null;
  }

  // Try to close via CDP if we have a connection
  if (currentWsUrl) {
    try {
      const ws = new WebSocket(currentWsUrl);
      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
          setTimeout(() => {
            ws.close();
            resolve();
          }, 500);
        };
        ws.onerror = () => resolve();
        setTimeout(resolve, 2000);
      });
    } catch {
      // Ignore
    }
  }

  // Kill spawned process and wait for it to exit
  if (chromeProcess) {
    const proc = chromeProcess;
    chromeProcess = null;
    proc.kill();
    // Wait for process to actually exit (max 2s)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2000);
      proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  currentWsUrl = null;
  currentPort = null;
  connectionPromise = null;

  // Clean up temp user data dir
  if (currentUserDataDir) {
    try {
      rmSync(currentUserDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    currentUserDataDir = null;
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
}

/**
 * Check if a port is available by trying to connect to CDP
 */
async function checkCdpPort(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    if (response.ok) {
      const data = await response.json();
      return data.webSocketDebuggerUrl;
    }
  } catch {
    // Port not available or not responding
  }
  return null;
}

/**
 * Find an available port for CDP
 */
async function findAvailablePort(): Promise<number> {
  for (let port = CDP_PORT_START; port <= CDP_PORT_END; port++) {
    const wsUrl = await checkCdpPort(port);
    if (!wsUrl) {
      return port;
    }
  }

  // All ports exhausted - try to close orphan Chrome instances via CDP
  console.warn("[mcx-cdp] All ports exhausted, attempting to close orphan instances...");
  for (let port = CDP_PORT_START; port <= CDP_PORT_END; port++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser`);
      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
          setTimeout(() => { ws.close(); resolve(); }, 300);
        };
        ws.onerror = () => resolve();
        setTimeout(resolve, 500);
      });
    } catch {
      // Ignore errors
    }
  }

  // Wait for processes to die
  await new Promise((r) => setTimeout(r, 1000));

  // Retry once
  for (let port = CDP_PORT_START; port <= CDP_PORT_END; port++) {
    const wsUrl = await checkCdpPort(port);
    if (!wsUrl) {
      return port;
    }
  }

  throw new Error(`No available ports in range ${CDP_PORT_START}-${CDP_PORT_END}. Try manually killing Chrome processes.`);
}

/**
 * Launch Chrome with remote debugging enabled
 * Returns the WebSocket URL for CDP connection
 */
async function launchChrome(headless: boolean = true): Promise<string> {
  // If we have a valid connection with matching mode, verify it's still working
  if (currentWsUrl && currentHeadless === headless && currentPort) {
    const wsUrl = await checkCdpPort(currentPort);
    if (wsUrl) {
      return wsUrl;
    }
    // Connection lost, reset state
    currentWsUrl = null;
    currentPort = null;
  }

  // Kill existing Chrome if mode changed
  if (currentPort) {
    await killChrome();
  }

  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error("Chrome not found. Install Chrome.");
  }

  currentHeadless = headless;
  const userDataDir = getUserDataDir();
  const port = await findAvailablePort();

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--hide-crash-restore-bubble",
  ];

  if (headless) {
    args.unshift("--headless=new");
  }

  // Spawn Chrome detached so it runs independently
  chromeProcess = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
  });
  chromeProcess.unref();
  currentPort = port;

  // Poll for CDP to be ready
  const maxWait = 15000;
  const pollInterval = 200;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    const wsUrl = await checkCdpPort(port);
    if (wsUrl) {
      currentWsUrl = wsUrl;
      return wsUrl;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error("Chrome failed to start within 15 seconds");
}

/**
 * Connect to Chrome DevTools Protocol
 */
async function connect(): Promise<CDPSession> {
  // Return existing session if still open
  if (session?.ws.readyState === WebSocket.OPEN) {
    return session;
  }

  // Prevent race conditions - reuse in-flight connection
  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    const wsUrl = await launchChrome(currentHeadless);
    const ws = new WebSocket(wsUrl);

    return new Promise<CDPSession>((resolve, reject) => {
      const newSession: CDPSession = {
        ws,
        id: 0,
        callbacks: new Map(),
      };

      ws.onopen = () => {
        session = newSession;
        resolve(newSession);
      };

      ws.onerror = (error) => {
        connectionPromise = null;
        reject(new Error(`CDP connection failed: ${error}`));
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data.toString());
        const callback = newSession.callbacks.get(message.id);
        if (callback) {
          newSession.callbacks.delete(message.id);
          if (message.error) {
            callback.reject(new Error(message.error.message));
          } else {
            callback.resolve(message.result);
          }
        }
      };

      ws.onclose = () => {
        session = null;
        connectionPromise = null;
      };
    });
  })();

  return connectionPromise;
}

/**
 * Send CDP command
 */
async function sendCommand<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string
): Promise<T> {
  const s = await connect();
  const id = ++s.id;

  return new Promise((resolve, reject) => {
    s.callbacks.set(id, { resolve: resolve as (value: unknown) => void, reject });

    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }

    s.ws.send(JSON.stringify(message));

    setTimeout(() => {
      if (s.callbacks.has(id)) {
        s.callbacks.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }
    }, 30000);
  });
}

/**
 * Get list of available targets
 */
async function getTargets(): Promise<Array<{ id: string; title: string; url: string; type: string }>> {
  await launchChrome(currentHeadless);
  if (!currentPort) {
    throw new Error("Chrome not running");
  }
  const response = await fetch(`http://127.0.0.1:${currentPort}/json/list`);
  return response.json();
}

/**
 * Attach to a target
 */
async function attachToTarget(targetId: string): Promise<string> {
  const result = await sendCommand<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  return result.sessionId;
}

/**
 * Enable required CDP domains
 */
async function enableDomains(sessionId: string): Promise<void> {
  await Promise.all([
    sendCommand("Page.enable", {}, sessionId),
    sendCommand("DOM.enable", {}, sessionId),
    sendCommand("Runtime.enable", {}, sessionId),
  ]);
}

/**
 * Chrome DevTools Protocol Adapter
 */
export const chromeDevtools = defineAdapter({
  name: "browser",

  tools: {
    launch: {
      description: "Launch Chrome. Use headless=false to see the browser window.",
      parameters: {
        headless: { type: "boolean", description: "Headless mode (default: true)" },
      },
      execute: async (params: { headless?: boolean }) => {
        const headless = params.headless !== false;
        await launchChrome(headless);
        return { success: true, mode: headless ? "headless" : "visible", wsUrl: currentWsUrl };
      },
    },

    listPages: {
      description: "List all open browser tabs/pages",
      parameters: {},
      execute: async () => {
        const targets = await getTargets();
        return targets
          .filter((t) => t.type === "page")
          .map((t) => ({ targetId: t.id, title: t.title, url: t.url }));
      },
    },

    navigate: {
      description: "Navigate to a URL",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        url: { type: "string", required: true, description: "URL to navigate to" },
      },
      execute: async (params: { targetId: string; url: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);
        return sendCommand("Page.navigate", { url: params.url }, sessionId);
      },
    },

    screenshot: {
      description: "Capture a screenshot",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
      },
      execute: async (params: { targetId: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);
        const result = await sendCommand<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
        return { base64: result.data };
      },
    },

    evaluate: {
      description: "Execute JavaScript in the page",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        expression: { type: "string", required: true, description: "JavaScript to evaluate" },
      },
      execute: async (params: { targetId: string; expression: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);
        return sendCommand("Runtime.evaluate", {
          expression: params.expression,
          returnByValue: true,
          awaitPromise: true,
        }, sessionId);
      },
    },

    click: {
      description: "Click on an element by selector",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        selector: { type: "string", required: true, description: "CSS selector" },
      },
      execute: async (params: { targetId: string; selector: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);

        const result = await sendCommand<{ result: { value: { x: number; y: number } | null } }>(
          "Runtime.evaluate",
          {
            expression: `(() => {
              const el = document.querySelector('${escapeJsString(params.selector)}');
              if (!el) return null;
              const rect = el.getBoundingClientRect();
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            })()`,
            returnByValue: true,
          },
          sessionId
        );

        if (!result.result.value) {
          throw new Error(`Element not found: ${params.selector}`);
        }

        const { x, y } = result.result.value;
        await sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
        await sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
        await sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);

        return { success: true };
      },
    },

    fill: {
      description: "Fill an input element",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        selector: { type: "string", required: true, description: "CSS selector" },
        value: { type: "string", required: true, description: "Value to fill" },
      },
      execute: async (params: { targetId: string; selector: string; value: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);

        await sendCommand("Runtime.evaluate", {
          expression: `(() => {
            const el = document.querySelector('${escapeJsString(params.selector)}');
            if (el) { el.focus(); el.value = ''; }
          })()`,
          returnByValue: true,
        }, sessionId);

        for (const char of params.value) {
          await sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char }, sessionId);
          await sendCommand("Input.dispatchKeyEvent", { type: "char", key: char, text: char }, sessionId);
          await sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: char, text: char }, sessionId);
        }

        return { success: true };
      },
    },

    getText: {
      description: "Get text content of the page",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
      },
      execute: async (params: { targetId: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);
        const result = await sendCommand<{ result: { value: string } }>(
          "Runtime.evaluate",
          { expression: "document.body.innerText", returnByValue: true },
          sessionId
        );
        return { text: result.result.value };
      },
    },

    // HIGH PRIORITY

    waitFor: {
      description: "Wait for an element or text to appear on the page",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        selector: { type: "string", description: "CSS selector to wait for" },
        text: { type: "string", description: "Text content to wait for" },
        timeout: { type: "number", description: "Timeout in ms (default: 10000)" },
      },
      execute: async (params: { targetId: string; selector?: string; text?: string; timeout?: number }) => {
        if (!params.selector && !params.text) {
          throw new Error("Either selector or text must be provided");
        }

        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);

        const timeout = params.timeout ?? 10000;
        const pollInterval = 100;
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
          let found = false;

          if (params.selector) {
            const result = await sendCommand<{ result: { value: boolean } }>(
              "Runtime.evaluate",
              {
                expression: `!!document.querySelector('${escapeJsString(params.selector)}')`,
                returnByValue: true,
              },
              sessionId
            );
            found = result.result.value;
          } else if (params.text) {
            const result = await sendCommand<{ result: { value: boolean } }>(
              "Runtime.evaluate",
              {
                expression: `document.body.innerText.includes('${escapeJsString(params.text)}')`,
                returnByValue: true,
              },
              sessionId
            );
            found = result.result.value;
          }

          if (found) {
            return { success: true, elapsed: Date.now() - startTime };
          }

          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }

        throw new Error(`Timeout waiting for ${params.selector ? `selector: ${params.selector}` : `text: ${params.text}`}`);
      },
    },

    pressKey: {
      description: "Press a key or key combination (e.g., 'Enter', 'Tab', 'Escape', 'a', 'Control+c')",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        key: { type: "string", required: true, description: "Key to press (e.g., 'Enter', 'Tab', 'Control+a')" },
      },
      execute: async (params: { targetId: string; key: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);

        // Parse key combination
        const parts = params.key.split("+");
        const mainKey = parts.pop() || "";
        const modifiers = parts.map((m) => m.toLowerCase());

        // Build modifier flags
        let modifierFlags = 0;
        if (modifiers.includes("control") || modifiers.includes("ctrl")) modifierFlags |= 1;
        if (modifiers.includes("alt")) modifierFlags |= 2;
        if (modifiers.includes("shift")) modifierFlags |= 4;
        if (modifiers.includes("meta") || modifiers.includes("cmd")) modifierFlags |= 8;

        // Special key mappings
        const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
          enter: { key: "Enter", code: "Enter", keyCode: 13 },
          tab: { key: "Tab", code: "Tab", keyCode: 9 },
          escape: { key: "Escape", code: "Escape", keyCode: 27 },
          esc: { key: "Escape", code: "Escape", keyCode: 27 },
          backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
          delete: { key: "Delete", code: "Delete", keyCode: 46 },
          arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
          arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
          arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
          arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
          home: { key: "Home", code: "Home", keyCode: 36 },
          end: { key: "End", code: "End", keyCode: 35 },
          pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
          pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
          space: { key: " ", code: "Space", keyCode: 32 },
        };

        const keyInfo = keyMap[mainKey.toLowerCase()] || {
          key: mainKey,
          code: mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey,
          keyCode: mainKey.length === 1 ? mainKey.toUpperCase().charCodeAt(0) : 0,
        };

        // Press modifiers
        for (const mod of modifiers) {
          const modKey = mod === "ctrl" ? "Control" : mod.charAt(0).toUpperCase() + mod.slice(1);
          await sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: modKey,
            code: `${modKey}Left`,
            modifiers: modifierFlags,
          }, sessionId);
        }

        // Press main key
        await sendCommand("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: keyInfo.key,
          code: keyInfo.code,
          windowsVirtualKeyCode: keyInfo.keyCode,
          modifiers: modifierFlags,
        }, sessionId);

        // If it's a character key, send char event
        if (mainKey.length === 1 && !modifiers.length) {
          await sendCommand("Input.dispatchKeyEvent", {
            type: "char",
            text: mainKey,
            modifiers: modifierFlags,
          }, sessionId);
        }

        // Release main key
        await sendCommand("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: keyInfo.key,
          code: keyInfo.code,
          windowsVirtualKeyCode: keyInfo.keyCode,
          modifiers: modifierFlags,
        }, sessionId);

        // Release modifiers
        for (const mod of modifiers.reverse()) {
          const modKey = mod === "ctrl" ? "Control" : mod.charAt(0).toUpperCase() + mod.slice(1);
          await sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: modKey,
            code: `${modKey}Left`,
            modifiers: 0,
          }, sessionId);
        }

        return { success: true, key: params.key };
      },
    },

    snapshot: {
      description: "Get DOM snapshot with unique IDs for reliable element selection",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        depth: { type: "number", description: "Max depth to traverse (default: 10)" },
      },
      execute: async (params: { targetId: string; depth?: number }) => {
        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);
        await sendCommand("Accessibility.enable", {}, sessionId);

        const depth = params.depth ?? 10;

        // Get accessibility tree which has unique IDs
        const result = await sendCommand<{ result: { value: unknown } }>(
          "Runtime.evaluate",
          {
            expression: `(() => {
              const nodes = [];
              let uid = 0;

              function traverse(el, depth, parentUid) {
                if (depth <= 0 || !el) return;

                const currentUid = 'uid_' + (uid++);
                el.setAttribute('data-mcx-uid', currentUid);

                const rect = el.getBoundingClientRect();
                const node = {
                  uid: currentUid,
                  tag: el.tagName.toLowerCase(),
                  role: el.getAttribute('role') || el.tagName.toLowerCase(),
                  name: el.getAttribute('aria-label') || el.innerText?.slice(0, 50) || '',
                  attributes: {},
                  bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                };

                // Capture important attributes
                ['id', 'class', 'href', 'src', 'type', 'name', 'placeholder', 'value'].forEach(attr => {
                  if (el.hasAttribute(attr)) {
                    node.attributes[attr] = el.getAttribute(attr);
                  }
                });

                // Check if interactive
                const interactive = ['a', 'button', 'input', 'select', 'textarea'].includes(node.tag);
                if (interactive) node.interactive = true;

                nodes.push(node);

                // Traverse children
                for (const child of el.children) {
                  traverse(child, depth - 1, currentUid);
                }
              }

              traverse(document.body, ${depth}, null);
              return nodes;
            })()`,
            returnByValue: true,
          },
          sessionId
        );

        return { nodes: result.result.value };
      },
    },

    clickUid: {
      description: "Click on an element by its MCX UID (from snapshot)",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        uid: { type: "string", required: true, description: "Element UID from snapshot" },
      },
      execute: async (params: { targetId: string; uid: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);

        const result = await sendCommand<{ result: { value: { x: number; y: number } | null } }>(
          "Runtime.evaluate",
          {
            expression: `(() => {
              const el = document.querySelector('[data-mcx-uid="${params.uid}"]');
              if (!el) return null;
              const rect = el.getBoundingClientRect();
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            })()`,
            returnByValue: true,
          },
          sessionId
        );

        if (!result.result.value) {
          throw new Error(`Element not found with UID: ${params.uid}`);
        }

        const { x, y } = result.result.value;
        await sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
        await sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
        await sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);

        return { success: true };
      },
    },

    fillUid: {
      description: "Fill an input element by its MCX UID (from snapshot)",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        uid: { type: "string", required: true, description: "Element UID from snapshot" },
        value: { type: "string", required: true, description: "Value to fill" },
      },
      execute: async (params: { targetId: string; uid: string; value: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);

        const found = await sendCommand<{ result: { value: boolean } }>(
          "Runtime.evaluate",
          {
            expression: `(() => {
              const el = document.querySelector('[data-mcx-uid="${params.uid}"]');
              if (el) { el.focus(); el.value = ''; return true; }
              return false;
            })()`,
            returnByValue: true,
          },
          sessionId
        );

        if (!found.result.value) {
          throw new Error(`Element not found with UID: ${params.uid}`);
        }

        for (const char of params.value) {
          await sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char }, sessionId);
          await sendCommand("Input.dispatchKeyEvent", { type: "char", key: char, text: char }, sessionId);
          await sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: char, text: char }, sessionId);
        }

        return { success: true };
      },
    },

    // MEDIUM PRIORITY

    scroll: {
      description: "Scroll the page or an element",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        x: { type: "number", description: "Horizontal scroll amount in pixels" },
        y: { type: "number", description: "Vertical scroll amount in pixels" },
        selector: { type: "string", description: "CSS selector to scroll into view" },
      },
      execute: async (params: { targetId: string; x?: number; y?: number; selector?: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);

        if (params.selector) {
          await sendCommand(
            "Runtime.evaluate",
            {
              expression: `document.querySelector('${escapeJsString(params.selector)}')?.scrollIntoView({ behavior: 'smooth', block: 'center' })`,
              returnByValue: true,
            },
            sessionId
          );
        } else {
          await sendCommand(
            "Runtime.evaluate",
            {
              expression: `window.scrollBy(${params.x ?? 0}, ${params.y ?? 0})`,
              returnByValue: true,
            },
            sessionId
          );
        }

        return { success: true };
      },
    },

    hover: {
      description: "Hover over an element",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        selector: { type: "string", required: true, description: "CSS selector" },
      },
      execute: async (params: { targetId: string; selector: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);

        const result = await sendCommand<{ result: { value: { x: number; y: number } | null } }>(
          "Runtime.evaluate",
          {
            expression: `(() => {
              const el = document.querySelector('${escapeJsString(params.selector)}');
              if (!el) return null;
              const rect = el.getBoundingClientRect();
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            })()`,
            returnByValue: true,
          },
          sessionId
        );

        if (!result.result.value) {
          throw new Error(`Element not found: ${params.selector}`);
        }

        const { x, y } = result.result.value;
        await sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);

        return { success: true };
      },
    },

    emulate: {
      description: "Emulate device viewport, user agent, or color scheme",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        width: { type: "number", description: "Viewport width" },
        height: { type: "number", description: "Viewport height" },
        deviceScaleFactor: { type: "number", description: "Device scale factor (default: 1)" },
        mobile: { type: "boolean", description: "Emulate mobile device" },
        colorScheme: { type: "string", description: "Color scheme: 'light' or 'dark'" },
      },
      execute: async (params: {
        targetId: string;
        width?: number;
        height?: number;
        deviceScaleFactor?: number;
        mobile?: boolean;
        colorScheme?: string;
      }) => {
        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);

        const results: string[] = [];

        if (params.width || params.height) {
          await sendCommand(
            "Emulation.setDeviceMetricsOverride",
            {
              width: params.width ?? 1280,
              height: params.height ?? 720,
              deviceScaleFactor: params.deviceScaleFactor ?? 1,
              mobile: params.mobile ?? false,
            },
            sessionId
          );
          results.push(`Viewport set to ${params.width ?? 1280}x${params.height ?? 720}`);
        }

        if (params.colorScheme) {
          await sendCommand(
            "Emulation.setEmulatedMedia",
            {
              features: [{ name: "prefers-color-scheme", value: params.colorScheme }],
            },
            sessionId
          );
          results.push(`Color scheme set to ${params.colorScheme}`);
        }

        return { success: true, applied: results };
      },
    },

    newPage: {
      description: "Create a new browser tab/page",
      parameters: {
        url: { type: "string", description: "URL to open (default: about:blank)" },
      },
      execute: async (params: { url?: string }) => {
        const url = params.url ?? "about:blank";
        const result = await sendCommand<{ targetId: string }>("Target.createTarget", { url });
        return { targetId: result.targetId, url };
      },
    },

    closePage: {
      description: "Close a browser tab/page",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID to close" },
      },
      execute: async (params: { targetId: string }) => {
        await sendCommand("Target.closeTarget", { targetId: params.targetId });
        return { success: true };
      },
    },

    // LOW PRIORITY - Debugging

    getConsoleMessages: {
      description: "Get console messages from the page",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        types: { type: "string", description: "Filter by types: 'log', 'error', 'warning', 'info' (comma-separated)" },
      },
      execute: async (params: { targetId: string; types?: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await sendCommand("Runtime.enable", {}, sessionId);
        await sendCommand("Console.enable", {}, sessionId);

        // Collect messages via evaluate since we can't easily get historical console
        const result = await sendCommand<{ result: { value: unknown[] } }>(
          "Runtime.evaluate",
          {
            expression: `(() => {
              if (!window.__mcxConsoleMessages) {
                window.__mcxConsoleMessages = [];
                const originalConsole = {};
                ['log', 'error', 'warn', 'info', 'debug'].forEach(type => {
                  originalConsole[type] = console[type];
                  console[type] = (...args) => {
                    window.__mcxConsoleMessages.push({
                      type,
                      message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
                      timestamp: Date.now()
                    });
                    if (window.__mcxConsoleMessages.length > 100) {
                      window.__mcxConsoleMessages.shift();
                    }
                    originalConsole[type].apply(console, args);
                  };
                });
              }
              return window.__mcxConsoleMessages;
            })()`,
            returnByValue: true,
          },
          sessionId
        );

        let messages = result.result.value as Array<{ type: string; message: string; timestamp: number }>;

        // Filter by types if specified
        if (params.types) {
          const allowedTypes = params.types.split(",").map((t) => t.trim().toLowerCase());
          messages = messages.filter((m) => allowedTypes.includes(m.type));
        }

        return { messages, count: messages.length };
      },
    },

    getNetworkRequests: {
      description: "Get network requests from the page",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        resourceTypes: { type: "string", description: "Filter by types: 'xhr', 'fetch', 'script', 'stylesheet', 'image' (comma-separated)" },
      },
      execute: async (params: { targetId: string; resourceTypes?: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await sendCommand("Network.enable", {}, sessionId);

        // Get performance entries which include network requests
        const result = await sendCommand<{ result: { value: unknown[] } }>(
          "Runtime.evaluate",
          {
            expression: `(() => {
              const entries = performance.getEntriesByType('resource');
              return entries.map(e => ({
                name: e.name,
                type: e.initiatorType,
                duration: Math.round(e.duration),
                size: e.transferSize || 0,
                status: 'completed'
              }));
            })()`,
            returnByValue: true,
          },
          sessionId
        );

        let requests = result.result.value as Array<{ name: string; type: string; duration: number; size: number }>;

        // Filter by resource types if specified
        if (params.resourceTypes) {
          const allowedTypes = params.resourceTypes.split(",").map((t) => t.trim().toLowerCase());
          requests = requests.filter((r) => allowedTypes.includes(r.type));
        }

        return { requests, count: requests.length };
      },
    },

    // LOW PRIORITY - Performance

    startTrace: {
      description: "Start performance tracing",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        categories: { type: "string", description: "Trace categories (default: standard web vitals)" },
      },
      execute: async (params: { targetId: string; categories?: string }) => {
        const sessionId = await attachToTarget(params.targetId);

        const categories = params.categories || "-*,devtools.timeline,v8.execute,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,toplevel,blink.console,disabled-by-default-devtools.timeline.stack";

        await sendCommand("Tracing.start", {
          categories,
          options: "sampling-frequency=10000",
        }, sessionId);

        // Store session for stopTrace
        activeTraceSessions.set(params.targetId, sessionId);

        return { success: true, message: "Tracing started" };
      },
    },

    stopTrace: {
      description: "Stop performance tracing and get results",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
      },
      execute: async (params: { targetId: string }) => {
        // Use stored session from startTrace, or create new one
        let sessionId = activeTraceSessions.get(params.targetId);
        const hadActiveTrace = !!sessionId;

        if (!sessionId) {
          sessionId = await attachToTarget(params.targetId);
        }

        // Get performance metrics
        const metrics = await sendCommand<{ metrics: Array<{ name: string; value: number }> }>(
          "Performance.getMetrics",
          {},
          sessionId
        );

        // Only end trace if we had an active one
        if (hadActiveTrace) {
          try {
            await sendCommand("Tracing.end", {}, sessionId);
          } catch {
            // Trace may have already ended
          }
          activeTraceSessions.delete(params.targetId);
        }

        // Get web vitals via evaluate
        const vitals = await sendCommand<{ result: { value: unknown } }>(
          "Runtime.evaluate",
          {
            expression: `(() => {
              const entries = performance.getEntriesByType('navigation')[0] || {};
              const paint = performance.getEntriesByType('paint');
              const fcp = paint.find(e => e.name === 'first-contentful-paint');
              const lcp = performance.getEntriesByType('largest-contentful-paint').pop();

              return {
                domContentLoaded: Math.round(entries.domContentLoadedEventEnd - entries.startTime) || null,
                load: Math.round(entries.loadEventEnd - entries.startTime) || null,
                fcp: fcp ? Math.round(fcp.startTime) : null,
                lcp: lcp ? Math.round(lcp.startTime) : null,
                ttfb: Math.round(entries.responseStart - entries.startTime) || null,
              };
            })()`,
            returnByValue: true,
          },
          sessionId
        );

        return {
          metrics: metrics.metrics.reduce((acc, m) => ({ ...acc, [m.name]: m.value }), {}),
          webVitals: vitals.result.value,
        };
      },
    },

    handleDialog: {
      description: "Handle JavaScript dialogs (alert, confirm, prompt)",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        accept: { type: "boolean", required: true, description: "Accept (true) or dismiss (false) the dialog" },
        promptText: { type: "string", description: "Text to enter for prompt dialogs" },
      },
      execute: async (params: { targetId: string; accept: boolean; promptText?: string }) => {
        const sessionId = await attachToTarget(params.targetId);
        await sendCommand("Page.enable", {}, sessionId);

        await sendCommand("Page.handleJavaScriptDialog", {
          accept: params.accept,
          promptText: params.promptText,
        }, sessionId);

        return { success: true, action: params.accept ? "accepted" : "dismissed" };
      },
    },

    uploadFile: {
      description: "Upload a file to a file input element",
      parameters: {
        targetId: { type: "string", required: true, description: "Target page ID" },
        selector: { type: "string", required: true, description: "CSS selector for file input" },
        filePath: { type: "string", required: true, description: "Absolute path to the file" },
      },
      execute: async (params: { targetId: string; selector: string; filePath: string }) => {
        // Validate file exists
        if (!existsSync(params.filePath)) {
          throw new Error(`File not found: ${params.filePath}`);
        }

        const sessionId = await attachToTarget(params.targetId);
        await enableDomains(sessionId);

        // Get the node ID of the file input
        const doc = await sendCommand<{ root: { nodeId: number } }>("DOM.getDocument", {}, sessionId);
        const node = await sendCommand<{ nodeId: number }>(
          "DOM.querySelector",
          { nodeId: doc.root.nodeId, selector: params.selector },
          sessionId
        );

        if (!node.nodeId) {
          throw new Error(`File input not found: ${params.selector}`);
        }

        // Set files on the input
        await sendCommand("DOM.setFileInputFiles", {
          nodeId: node.nodeId,
          files: [params.filePath],
        }, sessionId);

        return { success: true, file: params.filePath };
      },
    },

    close: {
      description: "Close the browser",
      parameters: {},
      execute: async () => {
        await killChrome();
        return { success: true };
      },
    },
  },
});

export default chromeDevtools;
