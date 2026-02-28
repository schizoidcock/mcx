/**
 * MCX Adapter Generator - React TUI
 */
import * as path from "path";
import { stat } from "fs/promises";
import * as nf from "@m234/nerd-fonts";
import { useState, useEffect, useCallback, memo } from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTimeline, useRenderer } from "@opentui/react";
import { Toaster, toast } from "@opentui-ui/toast/react";
import { DialogProvider, useDialog } from "@opentui-ui/dialog/react";
import {
  analyzeSource,
  extractApiName,
  getDefaultOutput,
  getAuthDescription,
  groupByCategory,
  generateAdapter,
  generateSDKAdapter,
  type SourceAnalysis,
  type DetectedAuth,
} from "./gen-core";

// ============================================================================
// Helpers
// ============================================================================

function getRelativeImportPath(configPath: string, adapterPath: string): string {
  const configDir = path.dirname(configPath);
  let relative = path.relative(configDir, adapterPath);
  relative = relative.replace(/\\/g, "/");
  relative = relative.replace(/\.ts$/, "");
  if (!relative.startsWith(".")) {
    relative = "./" + relative;
  }
  return relative;
}

// ============================================================================
// Types
// ============================================================================

interface GeneratorResult {
  source: string;
  name: string;
  output: string;
  baseUrl?: string;
  auth?: string;  // Only set if user overrides auto-detected
  readOnly?: boolean;
}

interface SelectOption {
  name: string;
  description: string;
  value: string;
}

// ============================================================================
// Colors
// ============================================================================

const COLORS = {
  primary: "#38BDF8",
  dim: "#64748B",
  text: "#E2E8F0",
  error: "#F87171",
  success: "#4ADE80",
  highlight: "#1E3A5F",
  folder: "#FBBF24",
  file: "#94A3B8",
};

const LOGO_COLORS = [
  "#38BDF8", "#3B82F6", "#6366F1", "#8B5CF6",
  "#A78BFA", "#8B5CF6", "#6366F1", "#3B82F6",
];

const MCX_LOGO = `███╗   ███╗ ██████╗██╗  ██╗
████╗ ████║██╔════╝╚██╗██╔╝
██╔████╔██║██║      ╚███╔╝
██║╚██╔╝██║██║      ██╔██╗
██║ ╚═╝ ██║╚██████╗██╔╝ ██╗
╚═╝     ╚═╝ ╚═════╝╚═╝  ╚═╝`;

// ============================================================================
// Components
// ============================================================================

// Memoized logo component using timeline animation instead of setInterval
const AnimatedLogo = memo(function AnimatedLogo() {
  const [colorIndex, setColorIndex] = useState(0);

  // Use timeline for smoother animation integrated with render loop
  const timeline = useTimeline({
    duration: LOGO_COLORS.length * 400,
    loop: true,
  });

  useEffect(() => {
    timeline.add(
      { index: 0 },
      {
        index: LOGO_COLORS.length,
        duration: LOGO_COLORS.length * 400,
        ease: "linear",
        onUpdate: (anim) => {
          const newIndex = Math.floor(anim.targets[0].index) % LOGO_COLORS.length;
          setColorIndex(newIndex);
        },
      }
    );
  }, [timeline]);

  return <text fg={LOGO_COLORS[colorIndex]}>{MCX_LOGO}</text>;
});

// Memoized SelectStep - hides cursor since no text input needed
const SelectStep = memo(function SelectStep({
  title,
  options,
  onSelect,
  onBack,
}: {
  title: string;
  options: SelectOption[];
  onSelect: (value: string) => void;
  onBack?: () => void;
}) {
  const renderer = useRenderer();

  // Hide cursor for select steps (no text input)
  useEffect(() => {
    renderer.setCursorPosition(0, 0, false);
  }, [renderer]);

  // Handle escape key with useKeyboard hook
  useKeyboard((key) => {
    if (key.name === "escape" && onBack) {
      onBack();
    }
  });

  return (
    <box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
    >
      <AnimatedLogo />
      <text> </text>
      <text fg={COLORS.dim}>Adapter Generator</text>
      <text> </text>
      <box
        borderStyle="rounded"
        borderColor={COLORS.dim}
        paddingX={2}
        paddingY={1}
        width={70}
        flexDirection="column"
        alignItems="center"
      >
        <text fg={COLORS.primary}>{title}</text>
        <text> </text>

        <select
          width={66}
          height={options.length * 2 + 2}
          options={options}
          selectedBackgroundColor={COLORS.highlight}
          selectedTextColor={COLORS.primary}
          focusedBackgroundColor="transparent"
          showDescription={true}
          showScrollIndicator={true}
          wrapSelection={true}
          focused={true}
          onSelect={(_index: number, option: SelectOption) => {
            onSelect(option.value);
          }}
        />

        <text> </text>
        <box width="100%" alignItems="center" justifyContent="center">
          <text fg={COLORS.dim}>
            {onBack ? "[↑↓] Nav • [⏎] Select • [Esc] Back" : "[↑↓] Nav • [⏎] Select • [^Q] Quit"}
          </text>
        </box>
      </box>
    </box>
  );
});

// InputStep - shows cursor for text input (memoized)
const InputStep = memo(function InputStep({
  title,
  placeholder,
  defaultValue,
  optional,
  onSubmit,
  onBack,
}: {
  title: string;
  placeholder: string;
  defaultValue?: string;
  optional?: boolean;
  onSubmit: (value: string) => void;
  onBack?: () => void;
}) {
  const [error, setError] = useState("");
  const [value, setValue] = useState(defaultValue || "");
  const renderer = useRenderer();

  // Show cursor for input steps
  useEffect(() => {
    renderer.setCursorPosition(0, 0, true);
  }, [renderer]);

  // Handle escape key with useKeyboard hook
  useKeyboard((key) => {
    if (key.name === "escape" && onBack) {
      onBack();
    }
  });

  return (
    <box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
    >
      <AnimatedLogo />
      <text> </text>
      <text fg={COLORS.dim}>Adapter Generator</text>
      <text> </text>
      <box
        borderStyle="rounded"
        borderColor={COLORS.dim}
        paddingX={2}
        paddingY={1}
        width={70}
        flexDirection="column"
        alignItems="center"
      >
        <text fg={COLORS.primary}>{title}</text>
        <text> </text>

        <input
          width={50}
          value={value}
          onInput={setValue}
          placeholder={placeholder}
          textColor={COLORS.text}
          cursorColor={COLORS.primary}
          focused={true}
          onSubmit={(val: string) => {
            const trimmed = val.trim() || (defaultValue || placeholder);
            if (!optional && !trimmed) {
              setError("This field is required");
              return;
            }
            onSubmit(trimmed);
          }}
        />

        <text> </text>
        {error && <text fg={COLORS.error}>✗ {error}</text>}

        <text fg={COLORS.dim}>
          {onBack
            ? (optional ? "[⏎] Skip • [Esc] Back" : "[⏎] Continue • [Esc] Back")
            : (optional ? "[⏎] Skip • [^Q] Quit" : "[⏎] Continue • [^Q] Quit")
          }
        </text>
      </box>
    </box>
  );
});

// Confirm Overwrite Dialog Content - uses useKeyboard for proper input handling
const ConfirmOverwriteContent = memo(function ConfirmOverwriteContent({
  filePath,
  onConfirm,
  onCancel,
}: {
  filePath: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useKeyboard((key) => {
    if (key.name === "y") {
      onConfirm();
    } else if (key.name === "n" || key.name === "escape") {
      onCancel();
    }
  });

  return (
    <box flexDirection="column" padding={1}>
      <text fg={COLORS.error}>File already exists:</text>
      <text fg={COLORS.dim}>{filePath}</text>
      <text> </text>
      <text fg={COLORS.text}>Overwrite?</text>
      <text> </text>
      <box flexDirection="row" gap={2}>
        <text fg={COLORS.primary}>[Y] Yes</text>
        <text fg={COLORS.dim}>[N] No</text>
      </box>
    </box>
  );
});

interface FileEntry {
  name: string;
  isDir: boolean;
  path: string;
}

// Helper to get Windows drives
async function getWindowsDrives(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const drives: string[] = [];
  // Check common drive letters
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const drivePath = `${letter}:\\`;
    try {
      const glob = new Bun.Glob("*");
      // Try to scan - if it works, drive exists
      for await (const _ of glob.scan({ cwd: drivePath, onlyFiles: false })) {
        drives.push(drivePath);
        break;
      }
    } catch {
      // Drive doesn't exist or not accessible
    }
  }
  return drives;
}

// Check if path is a Windows drive root
function isWindowsDriveRoot(p: string): boolean {
  return process.platform === "win32" && /^[A-Z]:\\?$/i.test(p);
}

// Step 2 Component - Source Path with integrated file explorer (memoized)
const SourcePathStep = memo(function SourcePathStep({
  sourceType,
  initialPath,
  initialInputValue,
  onPathSelected,
  onBack,
}: {
  sourceType: string;
  initialPath?: string;
  initialInputValue?: string;
  onPathSelected: (path: string, analysis: SourceAnalysis, directory: string, inputValue: string) => void;
  onBack: () => void;
}) {
  const [inputValue, setInputValue] = useState(initialInputValue || "");
  const [currentPath, setCurrentPath] = useState(initialPath || process.cwd());
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [showDrives, setShowDrives] = useState(false);
  const [loading, setLoading] = useState(true);
  const [focusInput, setFocusInput] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const renderer = useRenderer();

  const mode = sourceType === "single" ? "file" : "directory";
  const parentPath = path.dirname(currentPath);
  const isAtDriveRoot = isWindowsDriveRoot(currentPath);
  const isWindows = process.platform === "win32";

  // Cursor visibility based on input focus
  useEffect(() => {
    renderer.setCursorPosition(0, 0, focusInput);
  }, [renderer, focusInput]);

  // Reactive path update when inputValue changes
  useEffect(() => {
    if (!inputValue || inputValue.includes("*")) return;

    const timer = setTimeout(async () => {
      // Normalize path - remove trailing slashes for consistency
      const normalize = (p: string) => p.replace(/[\\/]+$/, "") || p;

      const exactPath = normalize(inputValue);

      // First, check if it's a file
      try {
        const s = await stat(exactPath);
        if (s.isFile()) {
          // It's a file - navigate to its directory and try to select it
          const fileDir = path.dirname(exactPath);
          if (normalize(fileDir) !== normalize(currentPath)) {
            setCurrentPath(fileDir);
          }
          // Don't navigate further - we found the file's directory
          return;
        }
        if (s.isDirectory() && normalize(exactPath) !== normalize(currentPath)) {
          setCurrentPath(exactPath);
          return;
        }
      } catch {
        // Path doesn't exist, try parent paths
      }

      // For file mode, also try the dirname (to show where the file would be)
      const targetDir = mode === "file" ? path.dirname(exactPath) : exactPath;

      // Only try parent if targetDir is different from current
      if (normalize(targetDir) === normalize(currentPath)) {
        return; // Already in the right directory
      }

      // Build list of parent directories to try
      let attempts = [targetDir];
      let parent = path.dirname(targetDir);
      while (parent && parent !== targetDir && attempts.length < 5) {
        attempts.push(normalize(parent));
        const nextParent = path.dirname(parent);
        if (nextParent === parent) break;
        parent = nextParent;
      }

      // Remove duplicates
      attempts = [...new Set(attempts)];

      for (const dir of attempts) {
        if (!dir) continue;
        if (normalize(dir) === normalize(currentPath)) continue;

        try {
          const s = await stat(dir);
          if (s.isDirectory()) {
            setCurrentPath(dir);
            return;
          }
        } catch {
          // Try next
        }
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [inputValue, mode]);

  // Auto-select file in list when inputValue matches an entry
  useEffect(() => {
    if (!inputValue || entries.length === 0) return;

    const normalize = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
    const normalizedInput = normalize(inputValue);

    // Find matching entry
    const matchIndex = entries.findIndex(entry =>
      normalize(entry.path) === normalizedInput ||
      entry.name.toLowerCase() === path.basename(normalizedInput)
    );

    if (matchIndex !== -1) {
      // Account for special options at the top (like ".." or "Select this directory")
      const offset = mode === "directory" ? 1 : 0; // "Select this directory" option
      const hasParent = parentPath !== currentPath ? 1 : 0;
      setSelectedIndex(matchIndex + offset + hasParent);
    }
  }, [inputValue, entries, mode, parentPath, currentPath]);

  // Load Windows drives on mount
  useEffect(() => {
    if (isWindows) {
      getWindowsDrives().then(setDrives);
    }
  }, []);

  // Load directory contents
  useEffect(() => {
    async function loadDir() {
      setLoading(true);
      try {
        const items: FileEntry[] = [];
        const glob = new Bun.Glob("*");

        for await (const name of glob.scan({ cwd: currentPath, onlyFiles: false })) {
          const fullPath = path.join(currentPath, name);

          let isDir = false;
          try {
            const stats = await stat(fullPath);
            isDir = stats.isDirectory();
          } catch {
            continue;
          }

          if (mode === "file") {
            const lowerName = name.toLowerCase();
            if (isDir) {
              items.push({ name, isDir: true, path: fullPath });
            } else if (lowerName.endsWith(".md") || lowerName.endsWith(".md.txt")) {
              items.push({ name, isDir: false, path: fullPath });
            }
          } else {
            if (isDir) {
              items.push({ name, isDir: true, path: fullPath });
            }
          }
        }

        items.sort((a, b) => {
          if (a.isDir && !b.isDir) return -1;
          if (!a.isDir && b.isDir) return 1;
          return a.name.localeCompare(b.name);
        });

        setEntries(items);
        setSelectedIndex(0); // Reset selection on directory change
      } catch {
        setEntries([]);
        setSelectedIndex(0);
      }
      setLoading(false);
    }
    loadDir();
  }, [currentPath, mode]);

  // Handle keyboard
  useKeyboard((key) => {
    if (key.name === "escape") {
      if (showDrives) {
        setShowDrives(false);
      } else {
        onBack();
      }
    } else if (key.name === "tab") {
      setFocusInput(!focusInput);
    } else if (key.name === "backspace" && !focusInput) {
      if (showDrives) {
        setShowDrives(false);
      } else if (isAtDriveRoot && isWindows) {
        setShowDrives(true);
      } else if (parentPath !== currentPath) {
        setCurrentPath(parentPath);
      }
    }
  });

  const handlePathSelected = async (selectedPath: string) => {
    const toastId = toast.loading("Analyzing source...");
    const result = await analyzeSource(selectedPath);

    if (!result.valid) {
      toast.error(result.error || "Invalid source", { id: toastId });
      return;
    }

    let info = result.summary;
    if (result.auth) {
      info += ` • Auth: ${getAuthDescription(result.auth)}`;
    }
    if (result.sdk) {
      info += ` • SDK: ${result.sdk.packageName}`;
    }

    toast.success(info, { id: toastId });
    onPathSelected(selectedPath, result, currentPath, inputValue);
  };

  // Get file icon
  const getFileIcon = (filePath: string, isDir: boolean): string => {
    if (isDir) {
      return nf.icons["nf-seti-folder"]?.value || "📁";
    }
    try {
      const icon = nf.fromPath(filePath, "seti");
      return icon?.value || "📄";
    } catch {
      return "📄";
    }
  };

  // Build options
  let options: { name: string; description: string; value: string; isDir: boolean }[] = [];

  if (showDrives) {
    const driveIcon = nf.icons["nf-fa-hdd_o"]?.value || "💾";
    options = drives.map((drive) => ({
      name: `${driveIcon} ${drive}`,
      description: "Drive",
      value: drive,
      isDir: true,
    }));
  } else {
    options = entries.map((entry) => ({
      name: `${getFileIcon(entry.path, entry.isDir)} ${entry.name}`,
      description: entry.isDir ? "Directory" : "File",
      value: entry.path,
      isDir: entry.isDir,
    }));

    const folderIcon = nf.icons["nf-seti-folder"]?.value || "📁";
    const driveIcon = nf.icons["nf-fa-hdd_o"]?.value || "💾";

    if (isWindows && isAtDriveRoot) {
      options.unshift({
        name: `${driveIcon} Switch drive...`,
        description: "Show all drives",
        value: "__SHOW_DRIVES__",
        isDir: true,
      });
    } else if (parentPath !== currentPath) {
      options.unshift({
        name: `${folderIcon} ..`,
        description: "Parent directory",
        value: parentPath,
        isDir: true,
      });
    }

    if (mode === "directory") {
      const checkIcon = nf.icons["nf-fa-check"]?.value || "✓";
      options.unshift({
        name: `${checkIcon} Select this directory`,
        description: currentPath,
        value: "__SELECT_CURRENT__",
        isDir: false,
      });
    }
  }

  return (
    <box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
    >
      <AnimatedLogo />
      <text> </text>
      <text fg={COLORS.dim}>Adapter Generator</text>
      <text> </text>
      <box
        borderStyle="rounded"
        borderColor={COLORS.dim}
        paddingX={2}
        paddingY={1}
        width={70}
        height={22}
        flexDirection="column"
      >
        {/* Title */}
        <box width="100%" alignItems="center" justifyContent="center">
          <text fg={COLORS.primary}>
            {mode === "file" ? "Select File" : "Select Directory"}
          </text>
        </box>
        <text> </text>

        {/* Path input */}
        <box flexDirection="row" alignItems="center" gap={1} marginBottom={1}>
          <text fg={COLORS.dim}>Path:</text>
          <input
            width={58}
            value={inputValue}
            onInput={setInputValue}
            placeholder={currentPath}
            textColor={COLORS.text}
            cursorColor={COLORS.primary}
            focused={focusInput}
            onSubmit={handlePathSelected}
          />
        </box>


        {/* File list */}
        {loading ? (
          <text fg={COLORS.dim}>Loading...</text>
        ) : options.length === 0 ? (
          <text fg={COLORS.dim}>No {mode === "file" ? "markdown files" : "directories"} found</text>
        ) : (
          <select
            width={66}
            height={10}
            options={options}
            selectedIndex={selectedIndex}
            selectedBackgroundColor={COLORS.highlight}
            selectedTextColor={COLORS.primary}
            focusedBackgroundColor="transparent"
            showDescription={false}
            showScrollIndicator={true}
            wrapSelection={true}
            focused={!focusInput}
            onChange={(index: number) => {
              setSelectedIndex(index);
            }}
            onSelect={(_index: number, option: { value: string; isDir?: boolean }) => {
              if (option.value === "__SHOW_DRIVES__") {
                setShowDrives(true);
              } else if (option.value === "__SELECT_CURRENT__") {
                handlePathSelected(currentPath);
              } else if (showDrives) {
                setCurrentPath(option.value);
                setShowDrives(false);
              } else if (option.isDir && option.value !== parentPath) {
                setCurrentPath(option.value);
                setInputValue("");
              } else if (option.value === parentPath) {
                setCurrentPath(parentPath);
                setInputValue("");
              } else {
                setInputValue(option.value);
                handlePathSelected(option.value);
              }
            }}
          />
        )}

        {/* Footer */}
        <text> </text>
        <box width="100%" alignItems="center" justifyContent="center">
          <text fg={COLORS.dim}>[Tab] Switch focus • [⏎] Select • [←] Up • [Esc] Back</text>
        </box>
      </box>
    </box>
  );
});

// Output Path Step - File browser for selecting output location
const OutputPathStep = memo(function OutputPathStep({
  defaultPath,
  defaultFilename,
  onPathSelected,
  onBack,
}: {
  defaultPath: string;
  defaultFilename: string;
  onPathSelected: (fullPath: string) => void;
  onBack: () => void;
}) {
  const [filename, setFilename] = useState(defaultFilename);
  const [currentPath, setCurrentPath] = useState(path.dirname(defaultPath));
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [showDrives, setShowDrives] = useState(false);
  const [loading, setLoading] = useState(true);
  const [focusInput, setFocusInput] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const renderer = useRenderer();

  const parentPath = path.dirname(currentPath);
  const isAtDriveRoot = isWindowsDriveRoot(currentPath);
  const isWindows = process.platform === "win32";
  const fullOutputPath = path.join(currentPath, filename);

  // Cursor visibility based on input focus
  useEffect(() => {
    renderer.setCursorPosition(0, 0, focusInput);
  }, [renderer, focusInput]);

  // Load Windows drives on mount
  useEffect(() => {
    if (isWindows) {
      getWindowsDrives().then(setDrives);
    }
  }, []);

  // Load directory contents
  useEffect(() => {
    async function loadDir() {
      setLoading(true);
      try {
        const items: FileEntry[] = [];
        const glob = new Bun.Glob("*");

        for await (const name of glob.scan({ cwd: currentPath, onlyFiles: false })) {
          const fullPath = path.join(currentPath, name);

          let isDir = false;
          try {
            const stats = await stat(fullPath);
            isDir = stats.isDirectory();
          } catch {
            continue;
          }

          // Show directories and .ts files
          if (isDir) {
            items.push({ name, isDir: true, path: fullPath });
          } else if (name.toLowerCase().endsWith(".ts")) {
            items.push({ name, isDir: false, path: fullPath });
          }
        }

        items.sort((a, b) => {
          if (a.isDir && !b.isDir) return -1;
          if (!a.isDir && b.isDir) return 1;
          return a.name.localeCompare(b.name);
        });

        setEntries(items);
        setSelectedIndex(0);
      } catch {
        setEntries([]);
        setSelectedIndex(0);
      }
      setLoading(false);
    }
    loadDir();
  }, [currentPath]);

  // Handle keyboard
  useKeyboard((key) => {
    if (key.name === "escape") {
      if (showDrives) {
        setShowDrives(false);
      } else {
        onBack();
      }
    } else if (key.name === "tab") {
      setFocusInput(!focusInput);
    } else if (key.name === "backspace" && !focusInput) {
      if (showDrives) {
        setShowDrives(false);
      } else if (isAtDriveRoot && isWindows) {
        setShowDrives(true);
      } else if (parentPath !== currentPath) {
        setCurrentPath(parentPath);
      }
    }
  });

  const handleSubmit = () => {
    if (!filename.trim()) {
      toast.error("Filename is required");
      return;
    }
    const finalFilename = filename.endsWith(".ts") ? filename : `${filename}.ts`;
    onPathSelected(path.join(currentPath, finalFilename));
  };

  // Get file icon
  const getFileIcon = (filePath: string, isDir: boolean): string => {
    if (isDir) {
      return nf.icons["nf-seti-folder"]?.value || "📁";
    }
    try {
      const icon = nf.fromPath(filePath, "seti");
      return icon?.value || "📄";
    } catch {
      return "📄";
    }
  };

  // Build options
  let options: { name: string; description: string; value: string; isDir: boolean }[] = [];

  if (showDrives) {
    const driveIcon = nf.icons["nf-fa-hdd_o"]?.value || "💾";
    options = drives.map((drive) => ({
      name: `${driveIcon} ${drive}`,
      description: "Drive",
      value: drive,
      isDir: true,
    }));
  } else {
    options = entries.map((entry) => ({
      name: `${getFileIcon(entry.path, entry.isDir)} ${entry.name}`,
      description: entry.isDir ? "Directory" : "File",
      value: entry.path,
      isDir: entry.isDir,
    }));

    const folderIcon = nf.icons["nf-seti-folder"]?.value || "📁";
    const driveIcon = nf.icons["nf-fa-hdd_o"]?.value || "💾";

    if (isWindows && isAtDriveRoot) {
      options.unshift({
        name: `${driveIcon} Switch drive...`,
        description: "Show all drives",
        value: "__SHOW_DRIVES__",
        isDir: true,
      });
    } else if (parentPath !== currentPath) {
      options.unshift({
        name: `${folderIcon} ..`,
        description: "Parent directory",
        value: parentPath,
        isDir: true,
      });
    }
  }

  return (
    <box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
    >
      <AnimatedLogo />
      <text> </text>
      <text fg={COLORS.dim}>Adapter Generator</text>
      <text> </text>
      <box
        borderStyle="rounded"
        borderColor={COLORS.dim}
        paddingX={2}
        paddingY={1}
        width={70}
        height={24}
        flexDirection="column"
      >
        {/* Title */}
        <box width="100%" alignItems="center" justifyContent="center">
          <text fg={COLORS.primary}>Output Path</text>
        </box>
        <text> </text>

        {/* Current directory display */}
        <box flexDirection="row" alignItems="center" gap={1} marginBottom={1}>
          <text fg={COLORS.dim}>Dir:</text>
          <text fg={COLORS.text}>{currentPath}</text>
        </box>

        {/* Filename input */}
        <box flexDirection="row" alignItems="center" gap={1} marginBottom={1}>
          <text fg={COLORS.dim}>File:</text>
          <input
            width={56}
            value={filename}
            onInput={setFilename}
            placeholder="adapter.ts"
            textColor={COLORS.text}
            cursorColor={COLORS.primary}
            focused={focusInput}
            onSubmit={handleSubmit}
          />
        </box>

        {/* File list */}
        {loading ? (
          <text fg={COLORS.dim}>Loading...</text>
        ) : options.length === 0 ? (
          <text fg={COLORS.dim}>Empty directory</text>
        ) : (
          <select
            width={66}
            height={8}
            options={options}
            selectedIndex={selectedIndex}
            selectedBackgroundColor={COLORS.highlight}
            selectedTextColor={COLORS.primary}
            focusedBackgroundColor="transparent"
            showDescription={false}
            showScrollIndicator={true}
            wrapSelection={true}
            focused={!focusInput}
            onChange={(index: number) => {
              setSelectedIndex(index);
            }}
            onSelect={(_index: number, option: { value: string; isDir?: boolean; name?: string }) => {
              if (option.value === "__SHOW_DRIVES__") {
                setShowDrives(true);
              } else if (showDrives) {
                setCurrentPath(option.value);
                setShowDrives(false);
              } else if (option.isDir && option.value !== parentPath) {
                setCurrentPath(option.value);
              } else if (option.value === parentPath) {
                setCurrentPath(parentPath);
              } else {
                // Selected a .ts file - use its name
                const selectedFilename = path.basename(option.value);
                setFilename(selectedFilename);
              }
            }}
          />
        )}

        {/* Full path preview */}
        <text> </text>
        <box flexDirection="row" alignItems="center" gap={1}>
          <text fg={COLORS.dim}>Output:</text>
          <text fg={COLORS.success}>{fullOutputPath}</text>
        </box>

        {/* Footer */}
        <text> </text>
        <box width="100%" alignItems="center" justifyContent="center">
          <text fg={COLORS.dim}>[Tab] Switch focus • [⏎] Confirm • [Esc] Back</text>
        </box>
      </box>
    </box>
  );
});

// Analysis Summary Step - Shows what was found in the source
const AnalysisSummaryStep = memo(function AnalysisSummaryStep({
  analysis,
  sourceType,
  sourcePath,
  onContinue,
  onBack,
}: {
  analysis: SourceAnalysis;
  sourceType: string;
  sourcePath: string;
  onContinue: () => void;
  onBack: () => void;
}) {
  const renderer = useRenderer();
  const byCategory = groupByCategory(analysis.endpoints);
  const categories = Object.entries(byCategory); // All categories - scrollbox handles overflow

  // Hide cursor for this step
  useEffect(() => {
    renderer.setCursorPosition(0, 0, false);
  }, [renderer]);

  useKeyboard((key) => {
    if (key.name === "escape") {
      onBack();
    } else if (key.name === "return") {
      onContinue();
    }
  });

  return (
    <box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
    >
      <AnimatedLogo />
      <text> </text>
      <text fg={COLORS.dim}>Adapter Generator</text>
      <text> </text>
      <box
        borderStyle="rounded"
        borderColor={COLORS.dim}
        paddingX={2}
        paddingY={1}
        width={70}
        height={22}
        flexDirection="column"
      >
        {/* Title */}
        <box width="100%" alignItems="center" justifyContent="center">
          <text fg={COLORS.primary}>Analysis Summary</text>
        </box>
        <text> </text>

        {/* Source info */}
        <box flexDirection="row" gap={1}>
          <text fg={COLORS.dim}>Source:</text>
          <text fg={COLORS.text}>{sourceType === "single" ? "Single file" : "Directory"}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={COLORS.dim}>Path:</text>
          <text fg={COLORS.text}>{sourcePath.length > 50 ? "..." + sourcePath.slice(-47) : sourcePath}</text>
        </box>
        <text> </text>

        {/* Stats */}
        <box flexDirection="row" gap={4}>
          <box flexDirection="row" gap={1}>
            <text fg={COLORS.success}>{analysis.filesWithSpecs.length}</text>
            <text fg={COLORS.dim}>file(s) with specs</text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={COLORS.primary}>{analysis.endpoints.length}</text>
            <text fg={COLORS.dim}>endpoints</text>
          </box>
        </box>
        {analysis.filesWithoutSpecs.length > 0 && (
          <box flexDirection="row" gap={1}>
            <text fg={COLORS.dim}>{analysis.filesWithoutSpecs.length} file(s) without specs</text>
          </box>
        )}
        <text> </text>

        {/* Categories - only show in batch mode, with scrollbox for overflow */}
        {sourceType === "batch" && categories.length > 0 && (
          <>
            <text fg={COLORS.dim}>{`Categories (${categories.length}):`}</text>
            <scrollbox
              width={40}
              height={Math.min(categories.length, 8)}
              scrollY={true}
              paddingLeft={2}
            >
              {categories.map(([cat, eps]) => {
                const displayCat = cat.length > 30 ? cat.slice(0, 27) + "..." : cat;
                return <text key={cat} fg={COLORS.text}>{`• ${displayCat}: ${eps.length}`}</text>;
              })}
            </scrollbox>
            <text> </text>
          </>
        )}

        {/* Methods breakdown - show in single file mode */}
        {sourceType === "single" && analysis.endpoints.length > 0 && (
          <>
            <text fg={COLORS.dim}>Methods:</text>
            <box flexDirection="row" gap={3} paddingLeft={2}>
              {["get", "post", "put", "patch", "delete"].map((method) => {
                const count = analysis.endpoints.filter((e) => e.method === method).length;
                return count > 0 ? (
                  <box key={method} flexDirection="row" gap={1}>
                    <text fg={COLORS.text}>{method.toUpperCase()}:</text>
                    <text fg={COLORS.primary}>{count}</text>
                  </box>
                ) : null;
              })}
            </box>
            <text> </text>
          </>
        )}

        {/* Auth/SDK info */}
        {analysis.auth && (
          <box flexDirection="row" gap={1}>
            <text fg={COLORS.dim}>Auth detected:</text>
            <text fg={COLORS.success}>{getAuthDescription(analysis.auth)}</text>
          </box>
        )}
        {analysis.sdk && (
          <box flexDirection="row" gap={1}>
            <text fg={COLORS.dim}>SDK:</text>
            <text fg={COLORS.success}>{analysis.sdk.packageName}</text>
          </box>
        )}

        {/* Footer */}
        <box flexGrow={1} />
        <box width="100%" alignItems="center" justifyContent="center">
          <text fg={COLORS.dim}>[⏎] Continue • [Esc] Back</text>
        </box>
      </box>
    </box>
  );
});

function GeneratorWizard({ onComplete }: { onComplete: (result: GeneratorResult | null) => void }) {
  const [step, setStep] = useState(1);
  const [sourceType, setSourceType] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [lastDirectory, setLastDirectory] = useState("");
  const [lastInputValue, setLastInputValue] = useState("");
  const [adapterName, setAdapterName] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [authOverride, setAuthOverride] = useState<string | undefined>(undefined);
  const [baseUrl, setBaseUrl] = useState<string | undefined>(undefined);
  const [readOnly, setReadOnly] = useState(false);
  const [generatedFile, setGeneratedFile] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<SourceAnalysis | null>(null);
  const [configStatus, setConfigStatus] = useState<"checking" | "none" | "exists" | "imported">("checking");
  const [configPath, setConfigPath] = useState<string | null>(null);
  const dialog = useDialog();

  // Check config status when we reach step 8
  useEffect(() => {
    if (step !== 8 || !generatedFile) return;
    (async () => {
      try {
        // Config is one level up from the adapters directory
        const adapterDir = path.dirname(generatedFile);
        const projectDir = path.dirname(adapterDir);
        const configFilePath = path.join(projectDir, "mcx.config.ts");

        if (!(await Bun.file(configFilePath).exists())) {
          setConfigStatus("none");
          setConfigPath(null);
          return;
        }

        setConfigPath(configFilePath);
        const content = await Bun.file(configFilePath).text();
        const importPath = getRelativeImportPath(configFilePath, generatedFile);
        if (content.includes(`from '${importPath}'`) || content.includes(`from "${importPath}"`)) {
          setConfigStatus("imported");
        } else {
          setConfigStatus("exists");
        }
      } catch (err) {
        console.error("Config check error:", err);
        setConfigStatus("none");
      }
    })();
  }, [step, generatedFile]);

  // Helper to generate adapter and go to success screen
  const doGenerate = useCallback(async (finalOutputPath: string, finalAuthOverride?: string) => {
    const toastId = toast.loading("Generating adapter...");
    try {
      const finalBaseUrl = analysis?.serverUrl || "";
      const finalAuth = finalAuthOverride || analysis?.auth;

      const adapterCode = analysis?.sdk
        ? generateSDKAdapter(adapterName, analysis.endpoints, analysis.sdk)
        : generateAdapter(adapterName, analysis!.endpoints, finalBaseUrl, finalAuth);

      await Bun.write(finalOutputPath, adapterCode);

      toast.success(`Generated: ${adapterName}.ts`, { id: toastId });
      setGeneratedFile(finalOutputPath);
      setStep(8);
    } catch (error) {
      toast.error(`Failed: ${error instanceof Error ? error.message : String(error)}`, { id: toastId });
    }
  }, [analysis, adapterName]);

  // Go back one step
  const goBack = useCallback(() => {
    if (step === 2) setStep(1);
    else if (step === 3) setStep(2);
    else if (step === 4) setStep(3);
    else if (step === 5) setStep(4);
    else if (step === 6) setStep(5);
    else if (step === 7) setStep(analysis?.auth ? 5 : 6); // Go to auth or output
    // Step 8 has no back - it's the final success screen
  }, [step, analysis?.auth]);

  // Step 1: Source Type
  if (step === 1) {
    return (
      <SelectStep
        title="Source Type"
        options={[
          { name: "Single file (.md)", description: "Generate from one OpenAPI markdown file", value: "single" },
          { name: "Directory (batch)", description: "Scan directory for multiple specs", value: "batch" },
        ]}
        onSelect={(value) => {
          setSourceType(value);
          setStep(2);
        }}
      />
    );
  }

  // Step 2: Source Path
  if (step === 2) {
    return (
      <SourcePathStep
        sourceType={sourceType}
        initialPath={lastDirectory}
        initialInputValue={lastInputValue}
        onPathSelected={async (selectedPath, sourceAnalysis, directory, inputVal) => {
          setAnalysis(sourceAnalysis);
          setSourcePath(selectedPath);
          setLastDirectory(directory);
          setLastInputValue(inputVal);

          // Try to extract API name from server URL
          const apiName = await extractApiName(selectedPath);
          const defaultName = apiName || path.basename(selectedPath).replace(/[^a-zA-Z0-9]/g, "_").replace(/_md$/, "");

          setAdapterName(defaultName);
          setOutputPath(getDefaultOutput(defaultName));
          setStep(3);
        }}
        onBack={goBack}
      />
    );
  }

  // Step 3: Analysis Summary
  if (step === 3 && analysis) {
    return (
      <AnalysisSummaryStep
        analysis={analysis}
        sourceType={sourceType}
        sourcePath={sourcePath}
        onContinue={() => setStep(4)}
        onBack={goBack}
      />
    );
  }

  // Step 4: Adapter Name
  if (step === 4) {
    return (
      <InputStep
        title="Adapter Name"
        placeholder="my_adapter"
        defaultValue={adapterName}
        onSubmit={(value) => {
          setAdapterName(value);
          setOutputPath(getDefaultOutput(value));
          setStep(5);
        }}
        onBack={goBack}
      />
    );
  }

  // Step 5: Output Path
  if (step === 5) {
    return (
      <OutputPathStep
        defaultPath={outputPath}
        defaultFilename={path.basename(outputPath)}
        onBack={goBack}
        onPathSelected={async (value) => {
          // Check if file exists
          const file = Bun.file(value);
          if (await file.exists()) {
            const confirmed = await dialog.confirm({
              content: ({ resolve }) => (
                <ConfirmOverwriteContent
                  filePath={value}
                  onConfirm={() => resolve(true)}
                  onCancel={() => resolve(false)}
                />
              ),
              fallback: false,
            });

            if (!confirmed) {
              toast.info("Choose a different path");
              return;
            }
            toast.success("Will overwrite existing file");
          }
          setOutputPath(value);
          // Skip steps if already detected
          if (analysis?.auth && analysis?.serverUrl) {
            // Both detected - generate directly
            doGenerate(value);
          } else if (analysis?.auth) {
            // Auth detected, need base URL
            setStep(7);
          } else {
            // Need auth
            setStep(6);
          }
        }}
      />
    );
  }

  // Step 6: Auth (only show if NOT detected)
  if (step === 6 && !analysis?.auth) {
    return (
      <SelectStep
        title="Authentication"
        options={[
          { name: "Basic (email + token)", description: "HTTP Basic Auth", value: "basic" },
          { name: "Bearer token", description: "Authorization: Bearer <token>", value: "bearer" },
          { name: "API Key", description: "X-API-Key header", value: "apikey" },
          { name: "None", description: "No authentication", value: "none" },
        ]}
        onSelect={(value) => {
          const auth = value === "none" ? undefined : value;
          setAuthOverride(auth);
          // Skip base URL step if already detected
          if (analysis?.serverUrl) {
            doGenerate(outputPath, auth);
          } else {
            setStep(7);
          }
        }}
        onBack={goBack}
      />
    );
  }

  // Step 7: Base URL (only show if NOT detected)
  if (step === 7 && !analysis?.serverUrl) {
    const authDesc = authOverride || (analysis?.auth ? getAuthDescription(analysis.auth) : "none");
    const fileCount = analysis?.filesWithSpecs.length || 0;
    const fileInfo = fileCount === 1 ? "1 file" : `${fileCount} files`;

    return (
      <InputStep
        title={`Base URL (not found in ${fileInfo}) • Auth: ${authDesc}`}
        placeholder="https://api.example.com"
        optional={false}
        onSubmit={async (value) => {
          if (!value) {
            toast.error("Base URL is required");
            return;
          }
          setBaseUrl(value);

          // Generate the adapter
          const toastId = toast.loading("Generating adapter...");
          try {
            const finalAuth = authOverride || analysis?.auth;

            const adapterCode = analysis?.sdk
              ? generateSDKAdapter(adapterName, analysis!.endpoints, analysis!.sdk)
              : generateAdapter(adapterName, analysis!.endpoints, value, finalAuth);

            await Bun.write(outputPath, adapterCode);

            toast.success(`Generated: ${adapterName}.ts`, { id: toastId });
            setGeneratedFile(outputPath);
            setStep(8);
          } catch (error) {
            toast.error(`Failed: ${error instanceof Error ? error.message : String(error)}`, { id: toastId });
          }
        }}
        onBack={goBack}
      />
    );
  }

  // Step 8: Success - Import to config, generate another, or exit
  if (step === 8) {
    const resetWizard = () => {
      setStep(1);
      setSourceType("");
      setSourcePath("");
      setAdapterName("");
      setOutputPath("");
      setAuthOverride(undefined);
      setBaseUrl(undefined);
      setAnalysis(null);
      setGeneratedFile(null);
      setConfigStatus("checking");
      setConfigPath(null);
    };

    const importToConfig = async () => {
      if (!configPath) {
        toast.error("Config file not found");
        return;
      }
      const configFile = Bun.file(configPath);
      const configContent = await configFile.text();

      // Check if adapter name already exists in imports
      // SECURITY: Escape adapterName for regex to prevent ReDoS
      const escapedName = adapterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const nameExistsRegex = new RegExp(`import\\s*\\{[^}]*\\b${escapedName}\\b[^}]*\\}`, "m");
      if (nameExistsRegex.test(configContent)) {
        toast.error(`Adapter "${adapterName}" already exists in config. Rename the adapter first.`);
        return;
      }

      const importPath = getRelativeImportPath(configPath, generatedFile!);
      const importStatement = `import { ${adapterName} } from '${importPath}';`;

      const lines = configContent.split("\n");
      let lastImportIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith("import ")) {
          lastImportIndex = i;
        }
      }

      if (lastImportIndex >= 0) {
        lines.splice(lastImportIndex + 1, 0, importStatement);
      } else {
        lines.unshift(importStatement);
      }

      let newContent = lines.join("\n");
      const adaptersRegex = /adapters:\s*\[([^\]]*)\]/s;
      const match = newContent.match(adaptersRegex);

      if (match) {
        let currentAdapters = match[1];

        // Remove comments and clean up
        const cleanedAdapters = currentAdapters
          .split('\n')
          .map(line => {
            // Remove inline comments
            const commentIndex = line.indexOf('//');
            if (commentIndex !== -1) {
              return line.slice(0, commentIndex);
            }
            return line;
          })
          .join('\n')
          .trim();

        // Extract actual adapter names (non-empty, non-whitespace tokens)
        const adapterTokens = cleanedAdapters
          .split(/[,\s]+/)
          .filter(token => token.length > 0 && token !== ',');

        // Add new adapter
        adapterTokens.push(adapterName);

        // Format the new adapters array
        const newAdapters = adapterTokens.length > 0
          ? adapterTokens.join(', ')
          : adapterName;

        newContent = newContent.replace(adaptersRegex, `adapters: [${newAdapters}]`);
      }

      await Bun.write(configPath, newContent);
      toast.success(`Added ${adapterName} to mcx.config.ts`);
      setConfigStatus("imported");
    };

    // Build options based on config status
    const options: Array<{ name: string; description: string; value: string }> = [];
    // Show import option if config exists or still checking (hide only if confirmed "none")
    if (configStatus === "exists" || configStatus === "checking") {
      options.push({
        name: "Import to mcx.config.ts",
        description: configStatus === "checking" ? "Checking config..." : "Add adapter to MCP config",
        value: "import"
      });
    }
    options.push({ name: "Generate another adapter", description: "Go back to start", value: "another" });
    options.push({ name: "Exit", description: "Close the generator", value: "exit" });

    const statusText = configStatus === "imported" ? " (imported to config)" : "";

    return (
      <SelectStep
        title={`✓ Generated: ${generatedFile}${statusText}`}
        options={options}
        onSelect={async (value) => {
          if (value === "import") {
            if (configStatus === "checking") {
              toast.info("Still checking config...");
              return;
            }
            if (configStatus === "none") {
              toast.error("No mcx.config.ts found");
              return;
            }
            await importToConfig();
          } else if (value === "another") {
            resetWizard();
          } else {
            onComplete(null);
          }
        }}
      />
    );
  }

  return null;
}

// App wrapper with providers
function App({ onComplete }: { onComplete: (result: GeneratorResult | null) => void }) {
  // Global keyboard handler for quit
  useKeyboard((key) => {
    if (key.ctrl && key.name === "q") {
      onComplete(null); // Quit without result
    }
  });

  return (
    <DialogProvider size="medium" closeOnEscape={true}>
      <box width="100%" height="100%">
        <GeneratorWizard onComplete={onComplete} />
        <Toaster position="bottom-right" />
      </box>
    </DialogProvider>
  );
}

// ============================================================================
// Main Export
// ============================================================================

export async function runGeneratorTUI(): Promise<GeneratorResult | null> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, // Ctrl+C for copy, Ctrl+Q to quit
    targetFPS: 60,
    useMouse: true,
    enableMouseMovement: true,
  });

  // Use underline cursor style (_) and disable blinking to prevent flickering
  renderer.setCursorStyle("underline", false);
  renderer.setCursorPosition(0, 0, false); // Hide cursor initially

  return new Promise((resolve) => {
    const root = createRoot(renderer);

    root.render(
      <App
        onComplete={(result) => {
          renderer.destroy();
          resolve(result);
        }}
      />
    );
  });
}

