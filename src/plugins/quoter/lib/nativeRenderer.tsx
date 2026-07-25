import { findByPropsAll } from "@metro";
import { useEffect, useMemo, useRef, useState } from "react";

import { QuotePayload } from "./quote";

type SvgModule = {
    Svg: any;
    Image: any;
    Rect: any;
    Defs: any;
    Mask: any;
    LinearGradient: any;
    Stop: any;
    Text: any;
    TSpan: any;
};

let svgModule: SvgModule | null | undefined;
const EXPORT_TIMEOUT_MS = 10_000;
const IMAGE_READY_TIMEOUT_MS = 500;

function getSvgModule(): SvgModule | null {
    if (svgModule !== undefined) return svgModule;

    try {
        svgModule = (findByPropsAll("Svg", "Image", "Rect", "Mask", "LinearGradient", "Stop", "Text", "TSpan") as SvgModule[])
            .find(candidate => Boolean(
                candidate?.Svg && candidate.Image && candidate.Rect && candidate.Defs && candidate.Mask &&
                candidate.LinearGradient && candidate.Stop && candidate.Text && candidate.TSpan,
            ))
            ?? null;
    } catch {
        svgModule = null;
    }

    return svgModule;
}

export function isNativeQuoteRendererAvailable(): boolean {
    return getSvgModule() !== null;
}

interface NativeQuoteRendererProps {
    payload: QuotePayload;
    width: number;
    onResult: (dataUrl: string) => void;
    onError: (message: string) => void;
}

export function NativeQuoteImage({ uri, width, height }: { uri: string; width: number; height: number; }) {
    const svg = getSvgModule();
    if (!svg) return null;

    return (
        <svg.Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
            <svg.Image href={{ uri }} x={0} y={0} width={width} height={height} />
        </svg.Svg>
    );
}

interface QuoteTextLayout {
    lines: string[];
    fontSize: number;
    lineHeight: number;
    authorFontSize: number;
    usernameFontSize: number;
    totalHeight: number;
}

function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
    // SVG does not provide synchronous text metrics.
    // A conservative average glyph width keeps the generated quote inside its
    // column, while the native SVG renderer handles the actual glyph shaping.
    const maxCharacters = Math.max(1, Math.floor(maxWidth / (fontSize * 0.52)));
    const words = String(text || " ").split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";

    for (const word of words) {
        if (word.length > maxCharacters) {
            if (line) {
                lines.push(line);
                line = "";
            }
            for (let offset = 0; offset < word.length; offset += maxCharacters) {
                lines.push(word.slice(offset, offset + maxCharacters));
            }
            continue;
        }

        const candidate = line ? `${line} ${word}` : word;
        if (candidate.length > maxCharacters && line) {
            lines.push(line);
            line = word;
        } else {
            line = candidate;
        }
    }

    if (line) lines.push(line);
    return lines.length ? lines : [" "];
}

function calculateTextLayout(payload: QuotePayload): QuoteTextLayout {
    const { image, fonts, spacing } = payload;
    let fontSize = fonts.initial;

    while (fontSize >= fonts.minimum) {
        const lines = wrapText(payload.quote, fontSize, image.quoteAreaWidth);
        const lineHeight = Math.round(fontSize * fonts.lineHeightMultiplier);
        const authorFontSize = Math.max(fonts.authorMinimum, Math.round(fontSize * fonts.authorMultiplier));
        const usernameFontSize = Math.max(fonts.usernameMinimum, Math.round(fontSize * fonts.usernameMultiplier));
        const totalHeight = lines.length * lineHeight + spacing.authorTop + authorFontSize + spacing.username + usernameFontSize;
        if (totalHeight <= image.maxContentHeight) {
            return { lines, fontSize, lineHeight, authorFontSize, usernameFontSize, totalHeight };
        }
        fontSize -= fonts.decrement;
    }

    const lines = wrapText(payload.quote, fonts.minimum, image.quoteAreaWidth);
    const lineHeight = Math.round(fonts.minimum * fonts.lineHeightMultiplier);
    return {
        lines,
        fontSize: fonts.minimum,
        lineHeight,
        authorFontSize: fonts.authorMinimum,
        usernameFontSize: fonts.usernameMinimum,
        totalHeight: lines.length * lineHeight + spacing.authorTop + fonts.authorMinimum + spacing.username + fonts.usernameMinimum,
    };
}

/**
 * Discord ships react-native-svg on Android and iOS. Its own toDataURL API
 * exports this SVG directly as the generated quote image.
 */
export function NativeQuoteRenderer({ payload, width, onResult, onError }: NativeQuoteRendererProps) {
    const svg = getSvgModule();
    const svgRef = useRef<any>(null);
    const captured = useRef(false);
    const [avatarState, setAvatarState] = useState<"loading" | "loaded" | "error">("loading");
    const [laidOut, setLaidOut] = useState(false);
    const layout = useMemo(() => calculateTextLayout(payload), [payload]);

    useEffect(() => {
        captured.current = false;
        setAvatarState("loading");
        setLaidOut(false);
    }, [payload.renderId]);

    useEffect(() => {
        if (avatarState === "error") onError("Failed to load avatar image.");
    }, [avatarState, onError]);

    useEffect(() => {
        if (!laidOut || avatarState !== "loading") return;
        // RNSVG can draw a cached image without dispatching a second onLoad.
        // Once the SVG has had a layout pass, allow that already-visible image
        // to export instead of leaving Send disabled indefinitely.
        const timer = setTimeout(() => setAvatarState("loaded"), IMAGE_READY_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [avatarState, laidOut]);

    useEffect(() => {
        if (!svg || captured.current || avatarState !== "loaded" || !laidOut) return;
        const renderer = svgRef.current;
        if (typeof renderer?.toDataURL !== "function") {
            onError("Discord SVG renderer cannot export an image on this build.");
            return;
        }

        let cancelled = false;
        let settled = false;
        const fail = (message: string) => {
            if (cancelled || settled) return;
            settled = true;
            captured.current = true;
            onError(message);
        };
        const timer = setTimeout(() => {
            try {
                renderer.toDataURL((base64: string) => {
                    if (cancelled || settled || captured.current) return;
                    settled = true;
                    clearTimeout(timeout);
                    captured.current = true;
                    if (typeof base64 !== "string" || !base64) {
                        onError("Discord SVG renderer returned an empty image.");
                        return;
                    }
                    onResult(base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`);
                }, {
                    width: payload.image.width,
                    height: payload.image.height,
                });
            } catch (error) {
                fail(String((error as any)?.message || "Failed to export quote image."));
            }
        }, 32);
        const timeout = setTimeout(() => fail("Quote image export timed out."), EXPORT_TIMEOUT_MS);

        return () => {
            cancelled = true;
            clearTimeout(timer);
            clearTimeout(timeout);
        };
    }, [avatarState, laidOut, onError, onResult, payload.image.height, payload.image.width, svg]);

    if (!svg) return null;

    const height = width * (payload.image.height / payload.image.width);
    const quoteCenterX = payload.image.quoteAreaX + payload.image.quoteAreaWidth / 2;
    const quoteStartY = (payload.image.height - layout.totalHeight) / 2 + layout.lineHeight;
    const authorY = quoteStartY + (layout.lines.length - 1) * layout.lineHeight + payload.spacing.authorTop;
    const usernameY = authorY + payload.spacing.username + layout.usernameFontSize;
    const fadeId = `quoter-fade-${String(payload.renderId || "preview").replace(/[^a-z0-9_-]/gi, "")}`;
    const grayscaleMaskId = `quoter-grayscale-${String(payload.renderId || "preview").replace(/[^a-z0-9_-]/gi, "")}`;

    return (
        <svg.Svg
            ref={svgRef}
            width={width}
            height={height}
            viewBox={`0 0 ${payload.image.width} ${payload.image.height}`}
            onLayout={() => setLaidOut(true)}
        >
            <svg.Defs>
                <svg.LinearGradient id={fadeId} x1="0%" y1="0%" x2="100%" y2="0%">
                    <svg.Stop offset="0" stopColor="#000" stopOpacity="0" />
                    <svg.Stop offset="1" stopColor="#000" stopOpacity="1" />
                </svg.LinearGradient>
                {payload.grayscale ? (
                    <svg.Mask
                        id={grayscaleMaskId}
                        x={0}
                        y={0}
                        width={payload.image.height}
                        height={payload.image.height}
                        maskUnits="userSpaceOnUse"
                        maskContentUnits="userSpaceOnUse"
                        maskType="luminance"
                    >
                        <svg.Image
                            href={{ uri: payload.avatarUrl }}
                            x={0}
                            y={0}
                            width={payload.image.height}
                            height={payload.image.height}
                            preserveAspectRatio="xMidYMid slice"
                            onLoad={() => setAvatarState("loaded")}
                            onError={() => setAvatarState("error")}
                        />
                    </svg.Mask>
                ) : null}
            </svg.Defs>
            <svg.Rect
                x={0}
                y={0}
                width={payload.image.width}
                height={payload.image.height}
                fill={payload.grayscale ? "#000001" : "#000"}
            />
            {payload.grayscale ? (
                <svg.Rect x={0} y={0} width={payload.image.height} height={payload.image.height} fill="#fffefd" mask={`url(#${grayscaleMaskId})`} />
            ) : null}
            {!payload.grayscale ? (
                <svg.Image
                    href={{ uri: payload.avatarUrl }}
                    x={0}
                    y={0}
                    width={payload.image.height}
                    height={payload.image.height}
                    preserveAspectRatio="xMidYMid slice"
                    onLoad={() => setAvatarState("loaded")}
                    onError={() => setAvatarState("error")}
                />
            ) : null}
            <svg.Rect
                x={payload.image.height - payload.spacing.gradientWidth}
                y={0}
                width={payload.spacing.gradientWidth}
                height={payload.image.height}
                fill={`url(#${fadeId})`}
            />
            <svg.Text
                x={quoteCenterX}
                y={quoteStartY}
                fill="#fff"
                fontSize={layout.fontSize}
                fontWeight="300"
                textAnchor="middle"
            >
                {layout.lines.map((line, index) => (
                    <svg.TSpan key={`${index}-${line}`} x={quoteCenterX} dy={index ? layout.lineHeight : 0}>
                        {line}
                    </svg.TSpan>
                ))}
            </svg.Text>
            <svg.Text
                x={quoteCenterX}
                y={authorY}
                fill="#fff"
                fontSize={layout.authorFontSize}
                fontWeight="300"
                fontStyle="italic"
                textAnchor="middle"
            >
                {`- ${payload.displayName}`}
            </svg.Text>
            <svg.Text
                x={quoteCenterX}
                y={usernameY}
                fill="#888"
                fontSize={layout.usernameFontSize}
                fontWeight="300"
                textAnchor="middle"
            >
                {payload.username}
            </svg.Text>
            {payload.showWatermark && payload.watermark ? (
                <svg.Text
                    x={payload.image.width - payload.spacing.watermarkPadding}
                    y={payload.image.height - payload.spacing.watermarkPadding}
                    fill="#888"
                    fontSize={payload.fonts.watermark}
                    fontWeight="300"
                    textAnchor="end"
                >
                    {payload.watermark}
                </svg.Text>
            ) : null}
        </svg.Svg>
    );
}
