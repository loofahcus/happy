import { useRef, useState, useCallback, useEffect } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { Terminal, type TerminalStatus, type TerminalKeySender } from "./Terminal";
import { TERMINAL_KEYS } from "./terminalKeys";

const STATUS_CONFIG: Record<
  TerminalStatus,
  { label: string; color: string }
> = {
  disconnected: { label: "Disconnected", color: "#8e8e93" },
  connecting: { label: "Connecting\u2026", color: "#ff9f0a" },
  connected: { label: "Connected", color: "#30d158" },
  closed: { label: "Exited", color: "#ff453a" },
};

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 300;

// Keys a soft keyboard has no way to produce. Ctrl is a sticky modifier
// handled separately; everything here writes its bytes straight through.
const KEY_BAR: { label: string; data: string; wide?: boolean }[] = [
  { label: "Esc", data: TERMINAL_KEYS.escape, wide: true },
  { label: "Tab", data: TERMINAL_KEYS.tab, wide: true },
  { label: "^C", data: TERMINAL_KEYS.interrupt },
  { label: "\u2190", data: TERMINAL_KEYS.left },
  { label: "\u2192", data: TERMINAL_KEYS.right },
  { label: "\u2191", data: TERMINAL_KEYS.up },
  { label: "\u2193", data: TERMINAL_KEYS.down },
];

// Only phones and tablets need the bar; a desktop browser already has the keys.
//
// Subscribed rather than sampled once at module load: a desktop browser toggled
// into device emulation changes pointer type without a reload, and that is
// exactly how this gets tested. The panel itself is web-only, so there is no
// native branch to carry.
const COARSE_POINTER_QUERY = "(pointer: coarse)";

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => {
    try {
      return window.matchMedia(COARSE_POINTER_QUERY).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let media: MediaQueryList;
    try {
      media = window.matchMedia(COARSE_POINTER_QUERY);
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    media.addEventListener("change", onChange);
    setCoarse(media.matches);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

interface TerminalPanelProps {
  sessionId: string;
  onClose: () => void;
}

export function TerminalPanel({
  sessionId,
  onClose,
}: TerminalPanelProps) {
  const { theme } = useUnistyles();
  const isDark = theme.dark;
  const destroyRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("disconnected");
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const isTouch = useCoarsePointer();
  const sendKeyRef = useRef<TerminalKeySender | null>(null);
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(DEFAULT_HEIGHT);

  if (Platform.OS !== "web") {
    return null;
  }

  const handleClose = () => {
    destroyRef.current?.();
    onClose();
  };

  const handleDragStart = (e: any) => {
    e.preventDefault();
    draggingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = height;

    const handleDragMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = startYRef.current - ev.clientY;
      const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeightRef.current + delta));
      setHeight(newHeight);
    };

    const handleDragEnd = () => {
      draggingRef.current = false;
      document.removeEventListener("mousemove", handleDragMove);
      document.removeEventListener("mouseup", handleDragEnd);
    };

    document.addEventListener("mousemove", handleDragMove);
    document.addEventListener("mouseup", handleDragEnd);
  };

  const statusConfig = STATUS_CONFIG[status];

  return (
    <View
      style={{
        height,
        borderTopWidth: 1,
        borderTopColor: theme.colors.surfaceHighest,
        backgroundColor: isDark ? "#1a1b26" : "#fdf6e3",
      }}
    >
      {/* Resize handle */}
      <View
        onStartShouldSetResponder={() => true}
        style={{
          height: 6,
          cursor: "ns-resize" as any,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: isDark
            ? "rgba(255,255,255,0.03)"
            : "rgba(0,0,0,0.03)",
        }}
        {...({ onMouseDown: handleDragStart } as any)}
      >
        <View
          style={{
            width: 32,
            height: 3,
            borderRadius: 1.5,
            backgroundColor: theme.colors.surfaceHighest,
          }}
        />
      </View>
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 12,
          paddingVertical: 4,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.surfaceHighest,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            style={{
              fontSize: 12,
              fontWeight: "600",
              color: theme.colors.textSecondary,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Terminal
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: statusConfig.color,
              }}
            />
            <Text
              style={{
                fontSize: 11,
                color: theme.colors.textSecondary,
                opacity: 0.8,
              }}
            >
              {statusConfig.label}
            </Text>
          </View>
        </View>
        <Pressable onPress={handleClose} hitSlop={8} style={{ padding: 4 }}>
          <Ionicons name="close" size={16} color={theme.colors.textSecondary} />
        </Pressable>
      </View>
      {/* Terminal content */}
      <View style={{ flex: 1 }}>
        <Terminal
          sessionId={sessionId}
          isDark={isDark}
          isActive={true}
          onDestroyReady={(fn) => {
            destroyRef.current = fn;
          }}
          onStatusChange={setStatus}
          ctrlArmed={ctrlArmed}
          onCtrlConsumed={() => setCtrlArmed(false)}
          onKeySenderReady={(send) => {
            sendKeyRef.current = send;
          }}
        />
      </View>
      {isTouch && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 8,
            paddingVertical: 6,
            borderTopWidth: 1,
            borderTopColor: theme.colors.surfaceHighest,
          }}
        >
          <KeyBarButton
            label="Ctrl"
            wide
            active={ctrlArmed}
            isDark={isDark}
            onPress={() => setCtrlArmed((armed) => !armed)}
          />
          {KEY_BAR.map((key) => (
            <KeyBarButton
              key={key.label}
              label={key.label}
              wide={key.wide}
              isDark={isDark}
              onPress={() => sendKeyRef.current?.(key.data)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function KeyBarButton({
  label,
  data: _data,
  wide,
  active,
  isDark,
  onPress,
}: {
  label: string;
  data?: string;
  wide?: boolean;
  active?: boolean;
  isDark: boolean;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      // A default browser mousedown would blur the terminal's helper textarea
      // and dismiss the soft keyboard before onPress ever runs.
      {...({
        onMouseDown: (e: any) => e.preventDefault(),
        onTouchStart: (e: any) => e.preventDefault(),
      } as any)}
      style={({ pressed }) => ({
        flex: wide ? 1.4 : 1,
        minHeight: 34,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 6,
        backgroundColor: active
          ? theme.colors.status.connecting
          : isDark
            ? "rgba(255,255,255,0.10)"
            : "rgba(0,0,0,0.07)",
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: "600",
          color: active ? "#1a1b26" : theme.colors.textSecondary,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
