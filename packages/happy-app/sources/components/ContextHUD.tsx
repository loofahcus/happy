import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Metadata } from '@/sync/storageTypes';

type UsageData = {
    inputTokens: number;
    outputTokens: number;
    contextSize: number;
    contextWindowSize: number;
};

type ContextHUDProps = {
    usageData: UsageData;
    alwaysShow?: boolean;
    quota?: Metadata['quota'];
};

function formatTokenCount(count: number): string {
    if (count >= 1_000_000) {
        return `${(count / 1_000_000).toFixed(1)}M`;
    }
    if (count >= 1_000) {
        return `${(count / 1_000).toFixed(0)}k`;
    }
    return `${count}`;
}

function getBarColor(percentage: number, theme: ReturnType<typeof useUnistyles>['theme']): string {
    if (percentage >= 85) return theme.colors.warningCritical;
    if (percentage >= 65) return "#E5A000";
    return theme.colors.success;
}

function getQuotaColor(percentage: number, theme: ReturnType<typeof useUnistyles>['theme']): string {
    if (percentage >= 80) return theme.colors.warningCritical;
    if (percentage >= 50) return "#E5A000";
    return theme.colors.textSecondary;
}

export const ContextHUD = React.memo(({ usageData, alwaysShow, quota }: ContextHUDProps) => {
    const { theme } = useUnistyles();

    const percentageUsed = Math.min(100, (usageData.contextSize / usageData.contextWindowSize) * 100);

    // Only show when > 50% used, unless alwaysShow or quota present
    if (!alwaysShow && !quota && percentageUsed < 50) {
        return null;
    }

    const barColor = getBarColor(percentageUsed, theme);

    return (
        <View style={styles.container}>
            {/* Progress bar */}
            <View style={[styles.barTrack, { backgroundColor: theme.colors.divider }]}>
                <View style={[styles.barFill, {
                    width: `${Math.max(1, percentageUsed)}%` as any,
                    backgroundColor: barColor,
                }]} />
            </View>
            {/* Token breakdown + percentage + quota */}
            <View style={styles.details}>
                <Text style={[styles.detailText, { color: barColor }]}>
                    {Math.round(percentageUsed)}%
                </Text>
                <Text style={[styles.detailText, { color: theme.colors.textSecondary }]}>
                    {formatTokenCount(usageData.contextSize)}/{formatTokenCount(usageData.contextWindowSize)}
                </Text>
                {quota && (
                    <Text style={[styles.detailText, { color: getQuotaColor(Math.round((quota.spend / quota.budget) * 100), theme) }]}>
                        ${quota.spend.toFixed(2)}/${quota.budget.toFixed(0)}
                    </Text>
                )}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'column',
        gap: 2,
        paddingVertical: 2,
    },
    barTrack: {
        height: 3,
        borderRadius: 1.5,
        overflow: 'hidden',
    },
    barFill: {
        height: '100%',
        borderRadius: 1.5,
    },
    details: {
        flexDirection: 'row',
        gap: 6,
        alignItems: 'center',
    },
    detailText: {
        fontSize: 10,
        ...Typography.default(),
    },
}));
