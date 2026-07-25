import { findAssetId } from "@api/assets";
import { dismissAlert, openAlert } from "@api/ui/alerts";
import { resolveSemanticColor, semanticColors } from "@api/ui/components/color";
import { showToast } from "@api/ui/toasts";
import { AlertActionButton, AlertActions, AlertModal, Text } from "@metro/common/components";
import { useEffect, useMemo, useState } from "react";
import { Dimensions, Image, ScrollView, Switch, TextInput, View } from "react-native";

import { buildFileName, buildPayload, getMessageChannelId, QUOTE_IMAGE_CONFIG } from "../lib/quote";
import { isNativeQuoteRendererAvailable, NativeQuoteImage, NativeQuoteRenderer } from "../lib/nativeRenderer";
import { sendQuoteAttachment } from "../lib/send";
import { useQuoterSettings } from "../storage";

const ALERT_KEY = "quoter-create-quote";
const WATERMARK_DEBOUNCE_MS = 500;

const toggleRowStyle = {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
} as const;

function resolveColor(token: any, fallback: string): string {
    try {
        return resolveSemanticColor(token) || fallback;
    } catch {
        return fallback;
    }
}

function QuotePreview({ message, dataUrl, onDataUrl }: {
    message: any;
    dataUrl: string;
    onDataUrl: (dataUrl: string) => void;
}) {
    const settings = useQuoterSettings();
    const [error, setError] = useState("");

    const grayscale = Boolean(settings.grayscale);
    const showWatermark = Boolean(settings.showWatermark);
    const watermark = String(settings.watermark ?? "");
    // Don't render with seeded defaults while the persisted settings file is
    // still hydrating — the sent image would ignore the user's preferences.
    const hydrated = Boolean((settings as any)._hasHydrated);

    // Typing in the watermark field edits a local draft; the native capture
    // only updates after a typing pause.
    const [watermarkDraft, setWatermarkDraft] = useState(watermark);
    useEffect(() => {
        if (watermarkDraft === watermark) return;
        const timer = setTimeout(
            () => settings.updateSettings({ watermark: watermarkDraft }),
            WATERMARK_DEBOUNCE_MS,
        );
        return () => clearTimeout(timer);
    }, [watermarkDraft]);

    const { renderId, payload } = useMemo(() => {
        const renderId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        return {
            renderId,
            payload: {
                ...buildPayload(message, { grayscale, showWatermark, watermark }),
                renderId,
            },
        };
    }, [message, grayscale, showWatermark, watermark]);

    useEffect(() => {
        setError("");
        onDataUrl("");
    }, [renderId]);

    const previewWidth = Math.max(
        230,
        Math.min((Dimensions.get("window")?.width ?? 360) - 88, 420),
    );
    const previewHeight = Math.round(previewWidth * (QUOTE_IMAGE_CONFIG.height / QUOTE_IMAGE_CONFIG.width));

    const textNormal = resolveColor(semanticColors.TEXT_NORMAL, "#fff");
    const textMuted = resolveColor(semanticColors.TEXT_MUTED, "#aaa");
    const textDanger = resolveColor(semanticColors.TEXT_DANGER ?? semanticColors.STATUS_DANGER, "#f66");

    return (
        <ScrollView
            style={{ maxHeight: 470 }}
            contentContainerStyle={{ paddingTop: 10, paddingBottom: 4 }}
        >
            <View
                style={{
                    width: previewWidth,
                    height: previewHeight,
                    alignSelf: "center",
                    borderRadius: 14,
                    overflow: "hidden",
                    backgroundColor: "#0f0f0f",
                    justifyContent: "center",
                    alignItems: "center",
                }}
            >
                {dataUrl ? (
                    isNativeQuoteRendererAvailable() ? (
                        <NativeQuoteImage uri={dataUrl} width={previewWidth} height={previewHeight} />
                    ) : (
                        <Image
                            source={{ uri: dataUrl }}
                            resizeMode="cover"
                            style={{ width: "100%", height: "100%" }}
                        />
                    )
                ) : hydrated && isNativeQuoteRendererAvailable() ? (
                    <>
                        <NativeQuoteRenderer
                            key={`quote-renderer-${renderId}`}
                            payload={payload}
                            width={previewWidth}
                            onResult={result => {
                                setError("");
                                onDataUrl(result);
                            }}
                            onError={message => setError(message)}
                        />
                        <View
                            pointerEvents="none"
                            style={{
                                position: "absolute",
                                left: 0,
                                top: 0,
                                width: "100%",
                                height: "100%",
                                justifyContent: "center",
                                alignItems: "center",
                                backgroundColor: "#0f0f0f",
                            }}
                        >
                            <Text variant="text-xs/medium" style={{ color: "#bbb", textAlign: "center", paddingHorizontal: 12 }}>
                                Generating preview...
                            </Text>
                        </View>
                    </>
                ) : (
                    // The preview box is always near-black, so this stays a fixed light gray.
                    <Text variant="text-xs/medium" style={{ color: "#bbb", textAlign: "center", paddingHorizontal: 12 }}>
                        {hydrated ? "Native image renderer unavailable — cannot render quote." : "Loading quote settings..."}
                    </Text>
                )}
            </View>
            {error ? (
                <Text variant="text-xs/medium" style={{ color: textDanger, marginTop: 8, textAlign: "center" }}>
                    {error}
                </Text>
            ) : null}
            <View style={toggleRowStyle}>
                <Text variant="text-md/medium" style={{ color: textNormal }}>Grayscale</Text>
                <Switch
                    value={grayscale}
                    onValueChange={(value: boolean) => settings.updateSettings({ grayscale: value })}
                />
            </View>
            <View style={toggleRowStyle}>
                <Text variant="text-md/medium" style={{ color: textNormal }}>Show Watermark</Text>
                <Switch
                    value={showWatermark}
                    onValueChange={(value: boolean) => settings.updateSettings({ showWatermark: value })}
                />
            </View>
            {showWatermark ? (
                <TextInput
                    value={watermarkDraft}
                    onChangeText={setWatermarkDraft}
                    placeholder="Watermark text (max 32 characters)"
                    placeholderTextColor={textMuted}
                    maxLength={32}
                    style={{
                        color: textNormal,
                        borderWidth: 1,
                        borderColor: textMuted,
                        borderRadius: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        marginTop: 10,
                    }}
                />
            ) : null}
        </ScrollView>
    );
}

function QuoteAlert({ message }: { message: any; }) {
    const [dataUrl, setDataUrl] = useState("");

    const onConfirm = () => {
        const channelId = getMessageChannelId(message);
        if (!channelId) {
            showToast("Unable to resolve channel.", findAssetId("CircleXIcon"));
            return;
        }

        dismissAlert(ALERT_KEY);
        sendQuoteAttachment(channelId, dataUrl, buildFileName(message))
            .then(() => showToast("Quote sent.", findAssetId("CheckIcon")))
            .catch(error => {
                const msg = error instanceof Error ? error.message : String(error);
                showToast(`Failed to send quote: ${msg}`, findAssetId("CircleXIcon"));
            });
    };

    return (
        <AlertModal
            title="Create Quote"
            content="Preview generated from selected message"
            extraContent={
                <QuotePreview message={message} dataUrl={dataUrl} onDataUrl={setDataUrl} />
            }
            actions={
                <AlertActions>
                    <AlertActionButton
                        text="Send"
                        variant="primary"
                        disabled={!dataUrl}
                        onPress={onConfirm}
                    />
                    <AlertActionButton text="Cancel" variant="secondary" />
                </AlertActions>
            }
        />
    );
}

export function openQuoteModal(message: any) {
    openAlert(ALERT_KEY, <QuoteAlert message={message} />);
}
