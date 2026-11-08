#!/usr/bin/env node
/**
 * Draws the images of the example article packages under fixtures/article-packages/<package>/assets/.
 *
 * Plain Node, built-in modules only (zlib for the PNG data): no dependency. The images are drawn from code, so the output is the same
 * on every run (a fixed pseudo-random generator, no timestamps, no metadata chunks: a PNG here is IHDR, IDAT and IEND, nothing
 * else, so there is no EXIF or text to leak). They are flat wireframes, a few KB each.
 *
 *   node scripts/fixtures/make-article-assets.mjs            writes the files into fixtures/article-packages
 *   node scripts/fixtures/make-article-assets.mjs <folder>   writes them into <folder>/<package>/assets instead
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_OUT = join(ROOT, "fixtures", "article-packages");

// --- A small RGB canvas -------------------------------------------------------------------------------------------

/** `#rrggbb` to `[r, g, b]`. */
function rgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The CRC-32 of the PNG and ZIP formats. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A 3x5 pixel font: enough for the labels of the figures. Rows are top to bottom, one string of three dots per row. */
const FONT = Object.fromEntries(
  Object.entries({
    " ": "000/000/000/000/000",
    "-": "000/000/111/000/000",
    ".": "000/000/000/000/010",
    ":": "000/010/000/010/000",
    "%": "101/001/010/100/101",
    ">": "100/010/001/010/100",
    '"': "101/101/000/000/000",
    ",": "000/000/000/010/100",
    "{": "011/010/110/010/011",
    "}": "110/010/011/010/110",
    $: "010/011/010/110/010",
    0: "111/101/101/101/111",
    1: "010/110/010/010/111",
    2: "110/001/010/100/111",
    3: "110/001/010/001/110",
    4: "101/101/111/001/001",
    5: "111/100/110/001/110",
    6: "011/100/111/101/111",
    7: "111/001/010/010/010",
    8: "111/101/111/101/111",
    9: "111/101/111/001/110",
    A: "010/101/111/101/101",
    B: "110/101/110/101/110",
    C: "011/100/100/100/011",
    D: "110/101/101/101/110",
    E: "111/100/110/100/111",
    F: "111/100/110/100/100",
    G: "011/100/101/101/011",
    H: "101/101/111/101/101",
    I: "111/010/010/010/111",
    J: "001/001/001/101/010",
    K: "101/101/110/101/101",
    L: "100/100/100/100/111",
    M: "101/111/111/101/101",
    N: "110/101/101/101/101",
    O: "010/101/101/101/010",
    P: "110/101/110/100/100",
    Q: "010/101/101/011/001",
    R: "110/101/110/101/101",
    S: "011/100/010/001/110",
    T: "111/010/010/010/010",
    U: "101/101/101/101/111",
    V: "101/101/101/101/010",
    W: "101/101/111/111/101",
    X: "101/101/010/101/101",
    Y: "101/101/010/010/010",
    Z: "111/001/010/100/111",
  }).map(([char, rows]) => [char, rows.split("/")]),
);

class Canvas {
  constructor(width, height, background) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
    this.rect(0, 0, width, height, background);
  }

  /** A filled rectangle, clipped to the canvas. */
  rect(x, y, w, h, color) {
    const [r, g, b] = rgb(color);
    for (let j = Math.max(0, y); j < Math.min(this.height, y + h); j += 1) {
      for (let i = Math.max(0, x); i < Math.min(this.width, x + w); i += 1) {
        const at = (j * this.width + i) * 3;
        this.pixels[at] = r;
        this.pixels[at + 1] = g;
        this.pixels[at + 2] = b;
      }
    }
  }

  /** A rectangle outline `t` pixels thick, drawn inwards. */
  frame(x, y, w, h, color, t = 2) {
    this.rect(x, y, w, t, color);
    this.rect(x, y + h - t, w, t, color);
    this.rect(x, y, t, h, color);
    this.rect(x + w - t, y, t, h, color);
  }

  /** A filled box with an outline. */
  box(x, y, w, h, fill, line, t = 3) {
    this.rect(x, y, w, h, fill);
    this.frame(x, y, w, h, line, t);
  }

  hline(x1, x2, y, color, t = 3) {
    this.rect(Math.min(x1, x2), y - Math.floor(t / 2), Math.abs(x2 - x1) + 1, t, color);
  }

  vline(x, y1, y2, color, t = 3) {
    this.rect(x - Math.floor(t / 2), Math.min(y1, y2), t, Math.abs(y2 - y1) + 1, color);
  }

  /** An arrow head pointing right, left or down, tip at (x, y). */
  head(x, y, direction, color, s = 9) {
    for (let k = 0; k < s; k += 1) {
      const spread = k;
      if (direction === "right") this.rect(x - k, y - spread, 1, spread * 2 + 1, color);
      if (direction === "left") this.rect(x + k, y - spread, 1, spread * 2 + 1, color);
      if (direction === "down") this.rect(x - spread, y - k, spread * 2 + 1, 1, color);
    }
  }

  /** A horizontal arrow from x1 to x2 (either direction) with its head at x2. */
  arrowAcross(x1, x2, y, color, t = 3) {
    const toRight = x2 > x1;
    this.hline(x1, toRight ? x2 - 8 : x2 + 8, y, color, t);
    this.head(x2, y, toRight ? "right" : "left", color);
  }

  arrowDown(x, y1, y2, color, t = 3) {
    this.vline(x, y1, y2 - 8, color, t);
    this.head(x, y2, "down", color);
  }

  /** Upper-case text from the 3x5 font, `scale` pixels per dot. */
  text(x, y, value, color, scale = 3) {
    let cursor = x;
    for (const char of value.toUpperCase()) {
      const glyph = FONT[char] ?? FONT[" "];
      glyph.forEach((row, j) => {
        for (let i = 0; i < 3; i += 1) {
          if (row[i] === "1") this.rect(cursor + i * scale, y + j * scale, scale, scale, color);
        }
      });
      cursor += 4 * scale;
    }
  }

  centered(cx, y, value, color, scale = 3) {
    this.text(Math.round(cx - (value.length * 4 * scale - scale) / 2), y, value, color, scale);
  }

  /** The PNG file: 8-bit RGB, no interlace, IHDR + IDAT + IEND only. */
  png() {
    const stride = this.width * 3;
    const raw = Buffer.alloc((stride + 1) * this.height);
    for (let j = 0; j < this.height; j += 1) {
      Buffer.from(this.pixels.buffer, j * stride, stride).copy(raw, j * (stride + 1) + 1);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

/** A small deterministic pseudo-random generator (mulberry32), so "noise" is the same on every run. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- The images ---------------------------------------------------------------------------------------------------

const INK = "#1e293b";
const MUTED = "#64748b";
const LINE = "#94a3b8";

/** A. The architecture figure: a request from the client to the store, with the queue between the API and the workers. */
function architectureOverview() {
  const c = new Canvas(1200, 600, "#f8fafc");
  c.text(40, 30, "RELAY ARCHITECTURE", INK, 5);
  c.hline(40, 1160, 74, "#cbd5e1", 2);

  const top = 150;
  const bottom = 380;
  const h = 110;
  const boxes = [
    { x: 40, y: top, w: 200, label: "CLIENT", sub: "WEB AND CLI", fill: "#e0f2fe", line: "#0369a1" },
    { x: 330, y: top, w: 200, label: "EDGE", sub: "TLS AND LIMITS", fill: "#e0f2fe", line: "#0369a1" },
    { x: 620, y: top, w: 200, label: "API", sub: "VALIDATES", fill: "#dcfce7", line: "#15803d" },
    { x: 910, y: top, w: 250, label: "QUEUE", sub: "DURABLE LOG", fill: "#fef3c7", line: "#b45309" },
    { x: 910, y: bottom, w: 250, label: "WORKERS", sub: "AT LEAST ONCE", fill: "#fce7f3", line: "#be185d" },
    { x: 620, y: bottom, w: 200, label: "STORE", sub: "POSTGRES", fill: "#ede9fe", line: "#6d28d9" },
    { x: 330, y: bottom, w: 200, label: "CACHE", sub: "READ MODEL", fill: "#ede9fe", line: "#6d28d9" },
  ];
  for (const box of boxes) {
    c.box(box.x, box.y, box.w, h, box.fill, box.line, 4);
    c.centered(box.x + box.w / 2, box.y + 28, box.label, INK, 5);
    c.centered(box.x + box.w / 2, box.y + 70, box.sub, MUTED, 3);
  }
  const upper = top + h / 2;
  const lower = bottom + h / 2;
  c.arrowAcross(240, 330, upper, INK);
  c.arrowAcross(530, 620, upper, INK);
  c.arrowAcross(820, 910, upper, INK);
  c.arrowDown(1035, top + h, bottom, INK);
  c.arrowAcross(910, 820, lower, INK);
  c.arrowAcross(620, 530, lower, LINE);
  c.text(40, 520, "SOLID LINE: REQUEST PATH", INK, 3);
  c.text(40, 548, "GREY LINE: CACHE REFRESH", MUTED, 3);
  return c;
}

/** B1. A terminal window with the install command. */
function terminalWindow() {
  const c = new Canvas(960, 540, "#0f172a");
  c.rect(0, 0, 960, 44, "#1e293b");
  for (const [i, color] of ["#ef4444", "#f59e0b", "#22c55e"].entries()) c.rect(20 + i * 30, 14, 16, 16, color);
  c.text(400, 14, "TERMINAL", "#cbd5e1", 4);
  c.text(40, 90, "$ NPM INSTALL --GLOBAL RELAY-CLI", "#e2e8f0", 4);
  c.text(40, 140, "ADDED 42 PACKAGES IN 6S", "#94a3b8", 4);
  c.text(40, 200, "$ RELAY --VERSION", "#e2e8f0", 4);
  c.text(40, 250, "RELAY 2.4.0", "#4ade80", 4);
  c.text(40, 320, "$ RELAY INIT", "#e2e8f0", 4);
  c.text(40, 370, "> PROJECT NAME: DEMO", "#94a3b8", 4);
  c.text(40, 420, "> CREATED RELAY.CONFIG.JSON", "#4ade80", 4);
  c.rect(40, 475, 22, 8, "#e2e8f0");
  return c;
}

/** B2. A code editor with the configuration file. */
function editorWindow() {
  const c = new Canvas(960, 540, "#ffffff");
  c.rect(0, 0, 960, 44, "#e2e8f0");
  c.text(24, 14, "EDITOR", INK, 4);
  c.rect(0, 44, 270, 496, "#f1f5f9");
  c.text(20, 70, "EXPLORER", MUTED, 3);
  for (const [i, name] of ["SRC", "DOCS", "RELAY.CONFIG.JSON", "PACKAGE.JSON"].entries()) {
    if (i === 2) c.rect(0, 100 + i * 40, 270, 34, "#dbeafe");
    c.text(30, 108 + i * 40, name, i === 2 ? INK : MUTED, 3);
  }
  c.rect(270, 44, 690, 40, "#f8fafc");
  c.text(290, 56, "RELAY.CONFIG.JSON", INK, 3);
  const lines = [
    ["{", "#334155", 0],
    ['"NAME": "DEMO",', "#0f766e", 1],
    ['"REGION": "EU",', "#0f766e", 1],
    ['"QUEUE": {', "#334155", 1],
    ['"RETRIES": 5,', "#b45309", 2],
    ['"TIMEOUT": 30', "#b45309", 2],
    ["}", "#334155", 1],
    ["}", "#334155", 0],
  ];
  lines.forEach(([text, color, depth], i) => {
    const y = 120 + i * 44;
    c.text(290, y, String(i + 1), LINE, 3);
    c.text(350 + depth * 36, y, text, color, 3);
  });
  c.rect(350 + 2 * 36 + 13 * 12 + 6, 120 + 5 * 44, 3, 15, INK);
  return c;
}

/** B3 and B4. The dashboard once the service runs, light and dark. */
function dashboard(dark) {
  const bg = dark ? "#0f172a" : "#f8fafc";
  const card = dark ? "#1e293b" : "#ffffff";
  const border = dark ? "#334155" : "#cbd5e1";
  const ink = dark ? "#e2e8f0" : INK;
  const muted = dark ? "#94a3b8" : MUTED;
  const c = new Canvas(960, 540, bg);
  c.rect(0, 0, 960, 56, dark ? "#020617" : "#0f172a");
  c.text(24, 18, "RELAY DASHBOARD", "#f8fafc", 4);
  const stats = [
    ["JOBS TODAY", "12480", "#38bdf8"],
    ["SUCCESS", "99.7%", "#4ade80"],
    ["P95 LATENCY", "84 MS", "#fbbf24"],
  ];
  stats.forEach(([label, value, color], i) => {
    const x = 30 + i * 304;
    c.box(x, 90, 280, 110, card, border, 3);
    c.text(x + 20, 108, label, muted, 3);
    c.text(x + 20, 148, value, ink, 6);
    c.rect(x + 20, 188, 60, 5, color);
  });
  c.box(30, 230, 900, 280, card, border, 3);
  c.text(50, 248, "JOBS PER HOUR", muted, 3);
  const next = random(dark ? 11 : 7);
  for (let i = 0; i < 24; i += 1) {
    const barHeight = 60 + Math.floor(next() * 150);
    c.rect(60 + i * 36, 490 - barHeight, 24, barHeight, dark ? "#38bdf8" : "#0369a1");
  }
  return c;
}

/** D. The before and after states of the case study: the same dashboard, crowded and then calm. */
function caseStudy(after) {
  const c = new Canvas(800, 500, after ? "#f8fafc" : "#fff7ed");
  c.rect(0, 0, 800, 50, after ? "#0f172a" : "#7c2d12");
  c.text(20, 15, after ? "AFTER" : "BEFORE", "#f8fafc", 5);
  c.text(560, 19, after ? "3 PANELS" : "14 PANELS", "#f8fafc", 3);
  const next = random(after ? 3 : 21);
  if (after) {
    const panels = [
      [30, 80, 350, 190, "ERRORS"],
      [420, 80, 350, 190, "LATENCY"],
      [30, 300, 740, 170, "QUEUE DEPTH"],
    ];
    for (const [x, y, w, h, label] of panels) {
      c.box(x, y, w, h, "#ffffff", "#cbd5e1", 3);
      c.text(x + 16, y + 14, label, MUTED, 3);
      const bars = Math.floor((w - 40) / 22);
      for (let i = 0; i < bars; i += 1) {
        const barHeight = 24 + Math.floor(next() * (h - 90));
        c.rect(x + 20 + i * 22, y + h - 16 - barHeight, 14, barHeight, "#0369a1");
      }
    }
  } else {
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (row * 5 + col >= 14) break;
        const x = 14 + col * 156;
        const y = 66 + row * 142;
        c.box(x, y, 146, 132, "#ffffff", ["#fb923c", "#f87171", "#facc15"][(row + col) % 3], 3);
        for (let i = 0; i < 6; i += 1) {
          const barHeight = 10 + Math.floor(next() * 70);
          c.rect(x + 12 + i * 21, y + 120 - barHeight, 14, barHeight, ["#fb923c", "#ef4444", "#a16207"][i % 3]);
        }
      }
    }
  }
  return c;
}

/** F1 to F3. One tile of the gallery in the variants article: a titled card with a row of bars, in its own colour. */
function galleryTile(label, fill, line, seed) {
  const c = new Canvas(600, 400, "#f8fafc");
  c.box(30, 30, 540, 340, fill, line, 5);
  c.text(60, 60, label, INK, 5);
  c.hline(60, 540, 112, line, 3);
  const next = random(seed);
  for (let i = 0; i < 9; i += 1) {
    const barHeight = 40 + Math.floor(next() * 150);
    c.rect(66 + i * 52, 340 - barHeight, 34, barHeight, line);
  }
  return c;
}

/** F4. The wide figure of the variants article: a long, low chart that is meant to use the whole width of the text. */
function wideChart() {
  const c = new Canvas(1600, 480, "#f8fafc");
  c.text(40, 30, "QUEUE DEPTH OVER ONE DAY", INK, 5);
  c.hline(40, 1560, 84, "#cbd5e1", 2);
  c.hline(60, 1540, 420, LINE, 3);
  c.vline(60, 110, 420, LINE, 3);
  const next = random(11);
  let level = 120;
  for (let i = 0; i < 48; i += 1) {
    level = Math.max(30, Math.min(280, level + Math.floor((next() - 0.45) * 90)));
    c.rect(76 + i * 30, 416 - level, 20, level, i % 12 === 7 ? "#b45309" : "#0369a1");
  }
  c.text(60, 440, "00:00", MUTED, 3);
  c.text(780, 440, "12:00", MUTED, 3);
  c.text(1480, 440, "24:00", MUTED, 3);
  return c;
}

/** Every image of every package: the path from the fixtures folder to the PNG bytes. */
export function generateAssets() {
  return new Map([
    ["a-architecture/assets/architecture-overview.png", architectureOverview().png()],
    ["b-tutorial/assets/step-1-install.png", terminalWindow().png()],
    ["b-tutorial/assets/step-2-config.png", editorWindow().png()],
    ["b-tutorial/assets/result-light.png", dashboard(false).png()],
    ["b-tutorial/assets/result-dark.png", dashboard(true).png()],
    ["d-case-study/assets/before.png", caseStudy(false).png()],
    ["d-case-study/assets/after.png", caseStudy(true).png()],
    ["f-variants/assets/tile-1.png", galleryTile("TILE ONE", "#e0f2fe", "#0369a1", 5).png()],
    ["f-variants/assets/tile-2.png", galleryTile("TILE TWO", "#dcfce7", "#15803d", 6).png()],
    ["f-variants/assets/tile-3.png", galleryTile("TILE THREE", "#fef3c7", "#b45309", 7).png()],
    ["f-variants/assets/wide-chart.png", wideChart().png()],
  ]);
}

function main() {
  const out = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT;
  for (const [path, bytes] of generateAssets()) {
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    console.log(`${path} ${bytes.length} bytes`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
