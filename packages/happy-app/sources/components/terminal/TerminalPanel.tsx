import { useRef, useState, useCallback } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { Terminal, type TerminalStatus } from "./Terminal";

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
        />
      </View>
    </View>
  );
}
