// news-image-20261120 — "The World in One Day: Friday 20 November 2026"
// Draws a 1024x1024 newspaper front page summarising the day's world news
// with a hand-written rasteriser and PNG encoder. Zero dependencies, no
// network, deterministic: the same bytes on every run.
//
// Run: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Writes $MAKEFUN_OUTPUT_DIR/entry.png (PNG, <= 1 MiB, 1024x1024).

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// ---------------------------------------------------------------------------
// 5x7 bitmap font (uppercase + digits + punctuation). Each glyph is 7 rows
// of 5 pixels, '#' = ink. Only the characters used in the layout are needed.
// ---------------------------------------------------------------------------

type Glyph = string[];

const FONT: Record<string, Glyph> = {
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  "J": ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "01100", "00100", "01000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  ";": ["00000", "01100", "01100", "00000", "01100", "00100", "01000"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "'": ["00100", "00100", "01000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  "&": ["01100", "10010", "10100", "01000", "10101", "10010", "01101"],
  "%": ["11001", "11010", "00010", "00100", "01000", "01011", "10011"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  '"': ["01010", "01010", "00000", "00000", "00000", "00000", "00000"],
  "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
};

function textWidth(text: string, scale: number): number {
  return text.length * 6 * scale;
}

// ---------------------------------------------------------------------------
// Raster canvas (RGBA, 8 bit per channel) with primitive drawing.
// ---------------------------------------------------------------------------

type RGBA = [number, number, number, number];

class Canvas {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
  }

  setPixel(x: number, y: number, c: RGBA): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = c[3];
  }

  fillRect(x: number, y: number, w: number, h: number, c: RGBA): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.setPixel(xx, yy, c);
    }
  }

  rectOutline(x: number, y: number, w: number, h: number, t: number, c: RGBA): void {
    this.fillRect(x, y, w, t, c);
    this.fillRect(x, y + h - t, w, t, c);
    this.fillRect(x, y, t, h, c);
    this.fillRect(x + w - t, y, t, h, c);
  }

  fillCircle(cx: number, cy: number, r: number, c: RGBA): void {
    for (let dy = -r; dy <= r; dy++) {
      const dx = Math.floor(Math.sqrt(r * r - dy * dy));
      for (let xx = cx - dx; xx <= cx + dx; xx++) this.setPixel(xx, cy + dy, c);
    }
  }

  circleOutline(cx: number, cy: number, r: number, t: number, c: RGBA): void {
    for (let a = 0; a < 360; a += 1) {
      const rad = (a * Math.PI) / 180;
      const x = Math.round(cx + r * Math.cos(rad));
      const y = Math.round(cy + r * Math.sin(rad));
      this.fillCircle(x, y, Math.max(1, Math.floor(t / 2)), c);
    }
  }

  // Bresenham line, thickness in pixels.
  line(x0: number, y0: number, x1: number, y1: number, t: number, c: RGBA): void {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    const rad = Math.max(1, Math.floor(t / 2));
    for (;;) {
      this.fillCircle(x, y, rad, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  // Filled triangle via horizontal scanlines.
  fillTriangle(
    ax: number, ay: number, bx: number, by: number, cx: number, cy: number, c: RGBA,
  ): void {
    const minY = Math.min(ay, by, cy);
    const maxY = Math.max(ay, by, cy);
    for (let y = minY; y <= maxY; y++) {
      const xs: number[] = [];
      const edges: Array<[number, number, number, number]> = [
        [ax, ay, bx, by],
        [bx, by, cx, cy],
        [cx, cy, ax, ay],
      ];
      for (const [x0, y0, x1, y1] of edges) {
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
          const t = (y - y0) / (y1 - y0);
          xs.push(Math.round(x0 + t * (x1 - x0)));
        }
      }
      if (xs.length >= 2) {
        const lo = Math.min(...xs);
        const hi = Math.max(...xs);
        for (let x = lo; x <= hi; x++) this.setPixel(x, y, c);
      }
    }
  }

  drawChar(ch: string, x: number, y: number, scale: number, c: RGBA): void {
    const glyph = FONT[ch] ?? FONT["?"];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === "1") {
          this.fillRect(x + col * scale, y + row * scale, scale, scale, c);
        }
      }
    }
  }

  drawText(text: string, x: number, y: number, scale: number, c: RGBA): void {
    // The bitmap font holds capitals only; uppercase everything so no
    // lowercase letter ever falls back to the "?" glyph.
    const upper = text.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
      this.drawChar(upper[i], x + i * 6 * scale, y, scale, c);
    }
  }

  drawTextCentered(text: string, cx: number, y: number, scale: number, c: RGBA): void {
    const w = textWidth(text, scale);
    this.drawText(text, cx - Math.floor(w / 2), y, scale, c);
  }

  // Word-wrap text to maxWidth pixels; returns the lines.
  wrapText(text: string, scale: number, maxWidth: number): string[] {
    const words = text.split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const trial = cur === "" ? w : cur + " " + w;
      if (textWidth(trial, scale) <= maxWidth) {
        cur = trial;
      } else {
        if (cur !== "") lines.push(cur);
        cur = w;
      }
    }
    if (cur !== "") lines.push(cur);
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Minimal deterministic PNG encoder (RGBA, filter 0, zlib level 9).
// ---------------------------------------------------------------------------

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(canvas: Canvas): Buffer {
  const raw = Buffer.alloc((canvas.width * 4 + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    const rowStart = y * (canvas.width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    canvas.data.copy(raw, rowStart + 1, y * canvas.width * 4, (y + 1) * canvas.width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.width, 0);
  ihdr.writeUInt32BE(canvas.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The front page.
// ---------------------------------------------------------------------------

const PAPER: RGBA = [246, 241, 231, 255];
const INK: RGBA = [22, 35, 63, 255];
const NAVY: RGBA = [22, 35, 63, 255];
const GOLD: RGBA = [232, 184, 75, 255];
const WHITE: RGBA = [255, 255, 255, 255];
const GREY: RGBA = [90, 88, 80, 255];
const CARD_BG: RGBA = [255, 255, 255, 255];
const CARD_LINE: RGBA = [216, 210, 196, 255];

interface Story {
  tag: string;
  color: RGBA;
  tint: RGBA;
  headline: string[];
  summary: string;
  icon: (cv: Canvas, bx: number, by: number) => void;
}

function iconSummit(cv: Canvas, bx: number, by: number): void {
  // Three leaders, three circles: blue, red, gold.
  cv.fillCircle(bx + 26, by + 46, 17, [29, 78, 137, 255]);
  cv.fillCircle(bx + 48, by + 38, 17, [178, 34, 34, 255]);
  cv.fillCircle(bx + 70, by + 46, 17, [212, 160, 40, 255]);
  cv.fillRect(bx + 12, by + 72, 72, 4, INK);
  cv.fillCircle(bx + 48, by + 20, 4, GOLD);
}

function iconJustice(cv: Canvas, bx: number, by: number): void {
  // Scales of justice.
  cv.fillRect(bx + 46, by + 14, 4, 58, INK);
  cv.fillRect(bx + 18, by + 22, 60, 4, INK);
  cv.fillCircle(bx + 48, by + 14, 5, INK);
  cv.line(bx + 20, by + 24, bx + 12, by + 48, 3, INK);
  cv.line(bx + 20, by + 24, bx + 28, by + 48, 3, INK);
  cv.fillTriangle(bx + 8, by + 48, bx + 32, by + 48, bx + 20, by + 60, [15, 118, 110, 255]);
  cv.line(bx + 76, by + 24, bx + 68, by + 48, 3, INK);
  cv.line(bx + 76, by + 24, bx + 84, by + 48, 3, INK);
  cv.fillTriangle(bx + 64, by + 48, bx + 88, by + 48, bx + 76, by + 60, [15, 118, 110, 255]);
  cv.fillRect(bx + 30, by + 76, 36, 4, INK);
}

function iconCyclone(cv: Canvas, bx: number, by: number): void {
  // Spiral storm: concentric arcs around a calm eye.
  cv.circleOutline(bx + 48, by + 48, 12, 4, [71, 85, 105, 255]);
  cv.circleOutline(bx + 48, by + 48, 24, 4, [71, 85, 105, 255]);
  cv.circleOutline(bx + 48, by + 48, 36, 4, [71, 85, 105, 255]);
  cv.fillCircle(bx + 48, by + 48, 5, GOLD);
  cv.fillRect(bx + 84, by + 44, 8, 4, [71, 85, 105, 255]);
}

function iconMarkets(cv: Canvas, bx: number, by: number): void {
  // Rising bars and an arrow.
  cv.fillRect(bx + 14, by + 20, 4, 60, INK);
  cv.fillRect(bx + 14, by + 76, 68, 4, INK);
  cv.fillRect(bx + 24, by + 62, 10, 14, [21, 128, 61, 255]);
  cv.fillRect(bx + 40, by + 50, 10, 26, [21, 128, 61, 255]);
  cv.fillRect(bx + 56, by + 38, 10, 38, [21, 128, 61, 255]);
  cv.line(bx + 22, by + 58, bx + 40, by + 44, 4, GOLD);
  cv.line(bx + 40, by + 44, bx + 58, by + 30, 4, GOLD);
  cv.line(bx + 58, by + 30, bx + 76, by + 18, 4, GOLD);
  cv.fillTriangle(bx + 76, by + 18, bx + 66, by + 20, bx + 74, by + 28, GOLD);
}

function iconBridge(cv: Canvas, bx: number, by: number): void {
  // A bridge deck, its arch, and a blast star.
  cv.fillRect(bx + 10, by + 58, 76, 5, INK);
  cv.circleOutline(bx + 48, by + 58, 26, 4, [153, 27, 27, 255]);
  cv.fillRect(bx + 20, by + 40, 4, 18, INK);
  cv.fillRect(bx + 46, by + 34, 4, 24, INK);
  cv.fillRect(bx + 72, by + 40, 4, 18, INK);
  for (let a = 0; a < 8; a++) {
    const rad = (a * Math.PI) / 4;
    cv.line(
      bx + 48, by + 18,
      bx + 48 + Math.round(14 * Math.cos(rad)),
      by + 18 + Math.round(14 * Math.sin(rad)),
      3, GOLD,
    );
  }
  cv.fillCircle(bx + 48, by + 18, 5, [153, 27, 27, 255]);
}

function iconBoat(cv: Canvas, bx: number, by: number): void {
  // A small boat on waves.
  cv.fillRect(bx + 46, by + 16, 4, 34, INK);
  cv.fillTriangle(bx + 50, by + 18, bx + 50, by + 44, bx + 76, by + 44, [3, 105, 161, 255]);
  cv.fillTriangle(bx + 20, by + 50, bx + 76, by + 50, bx + 68, by + 66, [3, 105, 161, 255]);
  cv.fillTriangle(bx + 20, by + 50, bx + 28, by + 66, bx + 68, by + 66, [3, 105, 161, 255]);
  cv.line(bx + 10, by + 76, bx + 30, by + 70, 3, [3, 105, 161, 255]);
  cv.line(bx + 30, by + 70, bx + 50, by + 76, 3, [3, 105, 161, 255]);
  cv.line(bx + 50, by + 76, bx + 70, by + 70, 3, [3, 105, 161, 255]);
  cv.line(bx + 70, by + 70, bx + 88, by + 76, 3, [3, 105, 161, 255]);
}

const STORIES: Story[] = [
  {
    tag: "DIPLOMACY",
    color: [29, 78, 137, 255],
    tint: [226, 236, 246, 255],
    headline: ["TRUMP, XI & PUTIN", "MEET IN CHINA"],
    summary:
      "First-ever three-way summit ends with a 'peace declaration' on nuclear arms.",
    icon: iconSummit,
  },
  {
    tag: "JUSTICE",
    color: [15, 118, 110, 255],
    tint: [222, 240, 238, 255],
    headline: ["ICJ: MYANMAR GUILTY", "OF GENOCIDE"],
    summary:
      "UN court rules Myanmar committed genocide against the Rohingya. No appeal.",
    icon: iconJustice,
  },
  {
    tag: "WEATHER",
    color: [71, 85, 105, 255],
    tint: [232, 235, 239, 255],
    headline: ["CYCLONE AKVAN", "NEARS INDIA"],
    summary:
      "Severe storm bears down on the Odisha coast. Schools shut, evacuations on.",
    icon: iconCyclone,
  },
  {
    tag: "TECH",
    color: [21, 128, 61, 255],
    tint: [222, 240, 228, 255],
    headline: ["ANTHROPIC'S HUGE", "MARKET DEBUT"],
    summary:
      "First pure AI company lists publicly. Valuation reported near 1.5 trillion.",
    icon: iconMarkets,
  },
  {
    tag: "WAR",
    color: [153, 27, 27, 255],
    tint: [244, 226, 226, 255],
    headline: ["CRIMEAN BRIDGE", "HIT AGAIN"],
    summary:
      "Ukraine strikes the bridge a third time in a week. Putin vows a harsher reply.",
    icon: iconBridge,
  },
  {
    tag: "AFRICA",
    color: [3, 105, 161, 255],
    tint: [222, 236, 245, 255],
    headline: ["BOAT SINKS OFF", "SENEGAL"],
    summary:
      "Migrant boat sinks off the coast. Dozens missing in the latest crossing tragedy.",
    icon: iconBoat,
  },
];

function buildImage(): Canvas {
  const W = 1024;
  const H = 1024;
  const cv = new Canvas(W, H);
  cv.fillRect(0, 0, W, H, PAPER);

  // Masthead.
  cv.fillRect(20, 20, W - 40, 150, NAVY);
  cv.fillRect(20, 20, W - 40, 4, GOLD);
  cv.fillRect(20, 166, W - 40, 4, GOLD);
  cv.drawTextCentered("THE WORLD IN ONE DAY", W / 2, 44, 4, WHITE);
  cv.drawTextCentered("FRIDAY 20 NOVEMBER 2026", W / 2, 100, 5, GOLD);

  // Kicker.
  cv.drawTextCentered("SIX STORIES THAT DEFINED THE DAY", W / 2, 190, 2, GREY);

  // Story grid: 2 columns x 3 rows.
  const cardW = 484;
  const cardH = 246;
  const gap = 16;
  const top = 216;
  for (let i = 0; i < STORIES.length; i++) {
    const s = STORIES[i];
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 20 + col * (cardW + gap);
    const y = top + row * (cardH + gap);

    cv.fillRect(x, y, cardW, cardH, CARD_BG);
    cv.rectOutline(x, y, cardW, cardH, 2, CARD_LINE);

    // Tag bar.
    cv.fillRect(x, y, cardW, 34, s.color);
    cv.drawText(s.tag, x + 14, y + 10, 2, WHITE);

    // Icon box.
    cv.fillRect(x + 16, y + 50, 96, 96, s.tint);
    cv.rectOutline(x + 16, y + 50, 96, 96, 2, s.color);
    s.icon(cv, x + 16, y + 50);

    // Headline (two fixed lines, scale 3).
    const tx = x + 128;
    cv.drawText(s.headline[0], tx, y + 52, 3, INK);
    cv.drawText(s.headline[1], tx, y + 78, 3, INK);
    cv.fillRect(tx, y + 106, 60, 3, s.color);

    // Summary, wrapped, scale 2.
    const lines = cv.wrapText(s.summary, 2, cardW - 128 - 16);
    for (let li = 0; li < lines.length; li++) {
      cv.drawText(lines[li], tx, y + 120 + li * 18, 2, GREY);
    }

    // Card footer: the day, repeated small so every panel is dated.
    cv.drawText("20 NOV 2026", x + 16, y + cardH - 24, 1, GREY);
  }

  // Footer.
  cv.drawTextCentered("WORLD NEWS AS REPORTED ON 20 NOVEMBER 2026", W / 2, 992, 1, GREY);

  return cv;
}

function main(): void {
  const outDir = process.env.MAKEFUN_OUTPUT_DIR;
  if (!outDir) {
    console.error("MAKEFUN_OUTPUT_DIR is not set");
    process.exit(1);
  }
  const canvas = buildImage();
  const png = encodePNG(canvas);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "entry.png");
  fs.writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes, 1024x1024)`);
}

main();
