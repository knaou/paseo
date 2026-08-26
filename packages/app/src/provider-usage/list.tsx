import { Fragment } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { providerUsageCopy } from "./copy";
import { ProviderUsageCard } from "./card";
import type { ProviderUsage } from "./types";

export function ProviderUsageList({ providers }: { providers: ProviderUsage[] }) {
  const visible = providers.filter((provider) => provider.status !== "unavailable");
  const unavailable = providers.filter((provider) => provider.status === "unavailable");

  return (
    <View style={styles.container}>
      {visible.length > 0 ? (
        <View style={settingsStyles.card}>
          {visible.map((usage, index) => (
            <Fragment key={usage.providerId}>
              {index > 0 ? <View style={styles.divider} /> : null}
              <ProviderUsageCard usage={usage} />
            </Fragment>
          ))}
        </View>
      ) : null}
      {unavailable.length > 0 ? (
        <Text style={styles.unavailableSummary}>
          {providerUsageCopy.unavailableSummary(
            unavailable.map((provider) => provider.displayName),
          )}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  unavailableSummary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[1],
  },
}));
