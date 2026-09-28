import { Text, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";

export type TerminalStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "closed";

interface TerminalProps {
  sessionId: string;
  isDark: boolean;
  isActive: boolean;
  onDestroyReady?: (destroy: () => void) => void;
  onStatusChange?: (status: TerminalStatus) => void;
}

export function Terminal({ isDark }: TerminalProps) {
  const { theme } = useUnistyles();

  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: isDark ? "#1a1b26" : "#fdf6e3",
        padding: 24,
      }}
    >
      <Text
        style={{
          color: theme.colors.textSecondary,
          fontSize: 14,
          textAlign: "center",
        }}
      >
        Terminal is available on desktop and web
      </Text>
    </View>
  );
}
