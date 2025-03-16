/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageExtra, MessageObject } from "@api/MessageEvents";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { findLazy } from "@webpack";

const TesseractLogger = new Logger("Tesseract", "#ff9e64");
let huskImage!: HTMLImageElement;
let worker!: Tesseract.Worker;
function reduceBboxGreatest(acc: Tesseract.Bbox, cur: Tesseract.Bbox): Tesseract.Bbox {
    return {
        x0: Math.min(acc.x0, cur.x0),
        x1: Math.max(acc.x1, cur.x1),
        y0: Math.min(acc.y0, cur.y0),
        y1: Math.max(acc.y1, cur.y1)
    };
}
function findWordLocation(text: Tesseract.Block[], regex: RegExp): Tesseract.Bbox[] {
    const locs: Tesseract.Bbox[] = [];
    for (let i = 0; i < text.length; i++) {
        const block = text[i];
        if (block.text.match(regex)) {
            const bl = locs.length;
            for (let j = 0; j < block.paragraphs.length; j++) {
                const paragraph = block.paragraphs[j];
                if (paragraph.text.match(regex)) {
                    const bl = locs.length;
                    for (let k = 0; k < paragraph.lines.length; k++) {
                        const line = paragraph.lines[k];
                        if (line.text.match(regex)) {
                            const bl = locs.length;
                            for (let l = 0; l < line.words.length; l++) {
                                const word = line.words[l];
                                let matches: RegExpExecArray[];
                                if ((matches = [...word.text.matchAll(new RegExp(regex, `${regex.flags.replace("g", "")}g`))]).length) {
                                    for (const match of matches) {
                                        const syms = word.symbols
                                            .slice(match.index, match.index + match[0].length)
                                            .map(x => x.bbox)
                                            .reduce(reduceBboxGreatest);
                                        locs.push(syms);
                                    }
                                }
                            }
                            if (locs.length === bl) {
                                locs.push(line.bbox);
                            }
                        }
                    }
                    if (locs.length === bl) {
                        locs.push(paragraph.bbox);
                    }
                }
            }
            if (locs.length === bl) {
                locs.push(block.bbox);
            }
        }
    }
    return locs;
}

interface CloudUpload {
    new(file: { file: File; isThumbnail: boolean; platform: number; }, channelId: string, showDiaglog: boolean, numCurAttachments: number): CloudUpload;
    upload(): void;
}
const CloudUpload: CloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

function getImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.src = URL.createObjectURL(file);
        img.onload = () => resolve(img);
        img.onerror = reject;
    });
}


function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise<Blob>(resolve => {
        canvas.toBlob(blob => {
            if (blob) {
                resolve(blob);
            } else {
                throw new Error("Failed to create Blob");
            }
        }, "image/png");
    });
}
const badRegex = /nix(?:os)?|This ?content ?is|blocked ?by ?this ?server/i;
export default definePlugin({
    name: "AntiTessie",
    authors: [Devs.sadan],
    description: "Scans your messages with ocr for anything that matches the selected regex, and if found, blurs it",

    async start() {
        if (!window?.Tesseract) {
            fetch(
                "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.0/dist/tesseract.min.js"
            )
                .then(async r => void (0, eval)(await r.text()))
                .then(async () => {
                    worker = await Tesseract.createWorker("eng", Tesseract.OEM.TESSERACT_LSTM_COMBINED, {
                        corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-simd-lstm.wasm.js",
                        workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.0/dist/worker.min.js",
                    });
                })
                .then(() => {
                    worker.setParameters({
                        tessedit_pageseg_mode: Tesseract.PSM.AUTO
                    });
                });
        }
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = "https://media.discordapp.net/stickers/1335394238799675403.webp?size=512&quality=lossless";
        huskImage = img;
    },

    stop() {
        worker.terminate();
    },


    async onBeforeMessageSend(channelId: string, message: MessageObject, extra: MessageExtra): Promise<void | { cancel: boolean; }> {
        if (extra.channel.guild_id !== "1015060230222131221" && extra.channel.guild_id !== "1041012073603289109") {
            return;
        }

        const uploads = extra?.uploads ?? [];
        for (let i = 0; i < uploads.length; i++) {
            async function convertToFile(canvas: HTMLCanvasElement): Promise<File> {
                const blob = await canvasToBlob(canvas);
                return new File([blob], `${upload.filename.substring(0, upload.filename.lastIndexOf("."))}.png`, {
                    type: "image/png"
                });
            }
            const upload = uploads[i];

            if (!upload.isImage) continue;

            const ret = await worker.recognize(upload.item.file, {
            }, {
                text: true,
                blocks: true,
            });
            console.log(ret);
            if (ret.data.text.match(badRegex)) {
                const toBlur = findWordLocation(ret.data.blocks!, badRegex);

                const sourceImage = await getImage(upload.item.file);
                const width = sourceImage.naturalWidth;
                const height = sourceImage.naturalHeight;

                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d")!;
                ctx.canvas.width = width;
                ctx.canvas.height = height;

                ctx.drawImage(sourceImage, 0, 0, width, height);
                for (const { x0, x1, y0, y1 } of toBlur) {
                    ctx.drawImage(huskImage, x0, y0, x1 - x0, y1 - y0);
                }
                const newFile = await convertToFile(canvas);
                const attachment = new CloudUpload({
                    file: newFile,
                    isThumbnail: false,
                    platform: 1
                }, channelId, false, uploads.length);
                attachment.upload();
                extra.uploads![i] = attachment as any;
            }
        }
    }

});
